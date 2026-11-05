"""Run real regression tests against isolated, deliberately broken copies. No credentials or API calls."""
from pathlib import Path
import hashlib, json, os, shutil, signal, subprocess, tempfile, time
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/reviews/2026-11-05/implementation/negative-controls'
OUT.mkdir(parents=True,exist_ok=True)
EXCLUDE={'.git','node_modules','dist','docs','.env','.env.local','.env.example','.serena','.claude'}
def ignore(path,names):
 return [n for n in names if n in EXCLUDE or n.startswith('.env') or n.endswith(('.sqlite','.sqlite-wal','.sqlite-shm')) or (Path(path).name=='lab' and n=='data')]
def snapshot(dest):
 shutil.copytree(ROOT,dest,ignore=ignore)
 for rel in ['node_modules','lab/node_modules','packages/eumenes-interact/node_modules']:
  p=dest/rel;p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to(ROOT/rel,target_is_directory=True)
 h=hashlib.sha256()
 for p in sorted(dest.rglob('*')):
  if p.is_file() and not p.is_symlink() and 'node_modules' not in p.parts:
   h.update(str(p.relative_to(dest)).encode());h.update(p.read_bytes())
 return h.hexdigest()
def run(cmd,cwd,log):
 env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR']}
 p=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
 try:output,_=p.communicate(timeout=16);code=p.returncode
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGKILL);output,_=p.communicate();code='timeout'
 log.write_bytes(output);return code
cases=[
 ('cancel','lab/host/control.ts','const result = await Promise.race([work, stopped]);','const result = await work;', ['bun','test','lab/test/host/run.test.ts','-t','interrupts an unresolved finish gate']),
 ('evidence','lab/host/run.ts','(step.basis === "observed"','(false && step.basis === "observed"',['bun','test','lab/test/host/goal-unmet.test.ts']),
 ('step-budget','lab/inference/call-budget.ts','const used = this.scopes.get(scope) ?? 0;','const used = 0;',['bun','test','lab/test/inference/call-budget.test.ts']),
 ('approval','lab/host/executor.ts','approvalNeeded(guard, await inspect(guard))','false',['bun','test','lab/test/host/parts.test.ts','-t','is asked first']),
 ('skill-integrity','lab/host/collab.ts','if (digest !== manifest.skills.browse.sha256)','if (false && digest !== manifest.skills.browse.sha256)',['bun','-e',"import {loadBrowseSkill} from './lab/host/collab.ts'; let refused=false; try{loadBrowseSkill()}catch(e){refused=e.message==='skill_digest_mismatch:browse'} if(!refused)process.exit(1)"])
]
results=[]
for name,file,old,new,cmd in cases:
 with tempfile.TemporaryDirectory(prefix='interact-negative-') as temp:
  dest=Path(temp)/'repo';digest=snapshot(dest)
  if name=='skill-integrity':
   p=dest/'skills/browse/SKILL.md';p.write_text(p.read_text()+'\ninvalid modification\n')
  baseline=run(cmd,dest,OUT/(name+'-baseline.log'))
  p=dest/file;s=p.read_text()
  if old not in s:raise RuntimeError('mutation_target_missing:'+name)
  s=s.replace(old,new,1)
  if name=='evidence':s=s.replace('(step.basis === "response"','(false && step.basis === "response"',1)
  p.write_text(s)
  mutant=run(cmd,dest,OUT/(name+'-mutant.log'))
  row={'name':name,'inputDigest':digest,'command':cmd,'baselineExit':baseline,'mutantExit':mutant,'detected':baseline==0 and mutant!=0}
  results.append(row);print(json.dumps(row),flush=True)
(OUT/'results.json').write_text(json.dumps({'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'isolated local negative controls; no root files, credentials or API requests changed','results':results},indent=2)+'\n')
if not all(r['detected'] for r in results):raise SystemExit(1)
