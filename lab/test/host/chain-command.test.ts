import { test, expect } from "bun:test";

for (const stepId of ["s1", "plan"])
	test(`the whole chain counts a budget-boundary choice once with opaque step ID ${stepId}`, async () => {
		const script = `
import {executeChain} from './lab/cli/chain-command.ts';
import {openLabDb} from './lab/host/db.ts';
import {silentLabLogger} from './lab/host/log.ts';
import {FakeBrowser} from './lab/test/host/fake-adapter.ts';
const db=openLabDb(':memory:');
let calls=0, printed;
console.log=(text)=>{ if(typeof text==='string' && text.startsWith('{')) printed=JSON.parse(text); };
const raw={complete:async()=>{
 const n=calls++;
 const text=n===0 ? JSON.stringify({steps:[{id:'${stepId}',goal:'observe and ask',inputs:[],output:'findings',browser:true,rationale:'explicit browser task',keepOpen:false,start:'https://ja.wikipedia.org/',completion:'observed'}]}) :
 n===9 ? JSON.stringify({action:'reply',text:'選択してください\\n1) A\\n2) B'}) : JSON.stringify({action:'invoke',tool:'page.read',arguments:{target:null,maxChars:1000}});
 return {kind:'text',text,usage:{inputTokens:1,outputTokens:1},latencyMs:1};
}};
const info=()=>({kind:'claude',provider:'anthropic',model:'stub',effort:'low'});
const code=await executeChain(db,{request:'observe and ask',inference:'claude',keepOpenIdleS:1,keepOpenMaxS:1,headed:false},silentLabLogger,{raw,port:raw,info,dispose:async()=>{}},async()=>({adapter:new FakeBrowser(),dispose:async()=>{}}));
const trial=db.query('SELECT inference_json FROM lab_trials').get();
process.stdout.write(JSON.stringify({code,calls,result:printed,trial:JSON.parse(trial.inference_json)}));
db.close();
`;
		const child = Bun.spawn(["bun", "-e", script], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH, HOME: process.env.HOME },
		});
		child.stdin.write("1\n");
		await child.stdin.flush();
		const text = await new Response(child.stdout).text();
		const exit = await child.exited;
		if (exit) throw new Error(await new Response(child.stderr).text());
		const out = JSON.parse(text);
		expect(out.code).toBe(1);
		expect(out.calls).toBe(10);
		expect(out.result.used).toBe(10);
		expect(out.result.outcomes[0].modelCalls).toBe(9);
		expect(out.result.outcomes[0].code).toBe("budget_exhausted");
		expect(out.result.facts).toEqual([]);
		expect(out.trial.kind).toBe("claude");
	});
