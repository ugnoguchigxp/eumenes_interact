/**
 * Package migrations, in order, append-only once the package is brought back to Eumenes (plan.md §3.3).
 * Eumenes names them `interact-package/NNNN` by position. Before the first bring-back this list may
 * still be rewritten; `test/sqlite/frozen-shape.test.ts` records every body's sha256 so an edit is
 * visible. Experiment tables (cases, trials) belong to the lab, not here.
 *
 * Enum CHECKs repeat contract vocabularies as literals on purpose: a migration body never changes
 * with the TypeScript constants, and the tests compare both. The tables never hold input values,
 * cookies, tokens or authenticated URLs (plan.md §14). Timestamps are UTC ISO 8601 text.
 */

const siteAndRunTables = `
-- Site knowledge (plan.md §7). Every row hangs off a scope (owner + normalized origin).
CREATE TABLE interact_site_scopes (
	id INTEGER PRIMARY KEY,
	owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
	origin TEXT NOT NULL CHECK (
		(origin LIKE 'http://_%' OR origin LIKE 'https://_%')
		AND origin = lower(origin)
		AND origin NOT GLOB '*[@?# ]*'
		AND instr(substr(origin, instr(origin, '://') + 3), '/') = 0
	),
	created_at TEXT NOT NULL,
	UNIQUE (owner, origin)
);

CREATE TABLE interact_page_profiles (
	id INTEGER PRIMARY KEY,
	scope_id INTEGER NOT NULL REFERENCES interact_site_scopes (id) ON DELETE CASCADE,
	name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
	description TEXT CHECK (description IS NULL OR length(description) <= 1000),
	-- A path pattern such as '/search'; never a query string or a full URL.
	url_hint TEXT CHECK (
		url_hint IS NULL OR (
			length(url_hint) <= 256 AND substr(url_hint, 1, 1) = '/'
			AND url_hint NOT GLOB '*[?#@]*'
		)
	),
	conditions_json TEXT NOT NULL CHECK (
		json_valid(conditions_json) AND json_type(conditions_json) = 'object'
	),
	basis TEXT CHECK (basis IS NULL OR length(basis) <= 1000),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (scope_id, name),
	UNIQUE (id, scope_id)
);

-- A logical name is unique inside one page profile of one scope; the same name may exist elsewhere.
CREATE TABLE interact_site_objects (
	id INTEGER PRIMARY KEY,
	scope_id INTEGER NOT NULL,
	page_profile_id INTEGER NOT NULL,
	logical_name TEXT NOT NULL CHECK (length(logical_name) BETWEEN 1 AND 128),
	role TEXT CHECK (role IS NULL OR length(role) <= 128),
	description TEXT CHECK (description IS NULL OR length(description) <= 1000),
	region TEXT CHECK (region IS NULL OR length(region) <= 256),
	important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
	revision INTEGER NOT NULL CHECK (revision >= 1),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (page_profile_id, scope_id)
		REFERENCES interact_page_profiles (id, scope_id) ON DELETE CASCADE,
	UNIQUE (page_profile_id, logical_name)
);
CREATE INDEX interact_site_objects_by_scope ON interact_site_objects (scope_id, logical_name);

-- Candidates are a set to match against the current observation, not a fallback chain.
CREATE TABLE interact_locator_candidates (
	id INTEGER PRIMARY KEY,
	object_id INTEGER NOT NULL REFERENCES interact_site_objects (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (
		kind IN ('role', 'label', 'test_id', 'attribute', 'structure', 'ax_identifier')
	),
	fields_json TEXT NOT NULL CHECK (
		json_valid(fields_json) AND json_type(fields_json) = 'object'
	),
	status TEXT NOT NULL DEFAULT 'candidate' CHECK (
		status IN ('candidate', 'verified', 'stale', 'disabled')
	),
	status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 64),
	status_changed_at TEXT NOT NULL,
	-- Where it came from: the platform and the fixed inspection that read it.
	source_adapter TEXT NOT NULL CHECK (
		source_adapter IN ('playwright-mcp', 'agent-browser', 'agent-desktop')
	),
	source_via TEXT NOT NULL CHECK (
		length(source_via) BETWEEN 1 AND 64 AND source_via NOT GLOB '*[^A-Za-z0-9_.-]*'
	),
	added_revision INTEGER NOT NULL CHECK (added_revision >= 1),
	created_at TEXT NOT NULL,
	UNIQUE (object_id, kind, fields_json, source_adapter, source_via)
);

-- Runs (plan.md §9). Versions and digests are frozen at creation.
CREATE TABLE interact_workflows (
	owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
	workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 128),
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner, workflow_id)
);

-- A published revision never changes (interact_workflow_revisions_immutable).
CREATE TABLE interact_workflow_revisions (
	owner TEXT NOT NULL,
	workflow_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision >= 1),
	format_version INTEGER NOT NULL CHECK (format_version >= 1),
	digest TEXT NOT NULL CHECK (length(digest) BETWEEN 1 AND 128),
	skill_ref TEXT NOT NULL CHECK (length(skill_ref) BETWEEN 1 AND 128),
	catalog_ref TEXT NOT NULL CHECK (length(catalog_ref) BETWEEN 1 AND 128),
	definition_json TEXT NOT NULL CHECK (
		json_valid(definition_json) AND json_type(definition_json) = 'object'
	),
	created_at TEXT NOT NULL,
	PRIMARY KEY (owner, workflow_id, revision),
	FOREIGN KEY (owner, workflow_id)
		REFERENCES interact_workflows (owner, workflow_id) ON DELETE CASCADE
);
CREATE TRIGGER interact_workflow_revisions_immutable
BEFORE UPDATE ON interact_workflow_revisions
BEGIN
	SELECT RAISE(ABORT, 'interact_immutable');
END;

CREATE TABLE interact_runs (
	run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 128),
	owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
	status TEXT NOT NULL CHECK (
		status IN (
			'queued', 'running', 'needs_input', 'completed', 'partial', 'failed',
			'cancelled', 'expired', 'indeterminate'
		)
	),
	status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 64),
	workflow_id TEXT,
	workflow_revision INTEGER,
	definition_digest TEXT,
	skill_ref TEXT NOT NULL CHECK (length(skill_ref) BETWEEN 1 AND 128),
	skill_digest TEXT NOT NULL CHECK (length(skill_digest) BETWEEN 1 AND 128),
	catalog_ref TEXT NOT NULL CHECK (length(catalog_ref) BETWEEN 1 AND 128),
	catalog_digest TEXT NOT NULL CHECK (length(catalog_digest) BETWEEN 1 AND 128),
	platform TEXT NOT NULL CHECK (
		platform IN ('playwright-mcp', 'agent-browser', 'agent-desktop')
	),
	core_format_version INTEGER NOT NULL CHECK (core_format_version >= 1),
	policy_json TEXT NOT NULL CHECK (
		json_valid(policy_json) AND json_type(policy_json) = 'object'
	),
	deadline_at TEXT,
	-- The core's state, opaque to the package. The revision counts saves (optimistic concurrency).
	core_state_json TEXT CHECK (core_state_json IS NULL OR json_valid(core_state_json)),
	core_state_revision INTEGER NOT NULL DEFAULT 0 CHECK (core_state_revision >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	CHECK (
		(workflow_id IS NULL) = (workflow_revision IS NULL)
		AND (workflow_id IS NULL) = (definition_digest IS NULL)
	),
	CHECK (
		(status IN ('completed', 'partial', 'failed', 'cancelled', 'expired', 'indeterminate'))
		= (finished_at IS NOT NULL)
	),
	FOREIGN KEY (owner, workflow_id, workflow_revision)
		REFERENCES interact_workflow_revisions (owner, workflow_id, revision)
);
CREATE INDEX interact_runs_by_owner ON interact_runs (owner, status, created_at);
CREATE TRIGGER interact_runs_terminal_immutable
BEFORE UPDATE ON interact_runs
WHEN OLD.status IN ('completed', 'partial', 'failed', 'cancelled', 'expired', 'indeterminate')
BEGIN
	SELECT RAISE(ABORT, 'interact_immutable');
END;

-- Operations (plan.md §5.5). The command is stored redacted: no typed text, no URL beyond its origin.
CREATE TABLE interact_operations (
	operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 128),
	run_id TEXT NOT NULL REFERENCES interact_runs (run_id) ON DELETE CASCADE,
	seq INTEGER NOT NULL CHECK (seq >= 1),
	status TEXT NOT NULL DEFAULT 'not_dispatched' CHECK (
		status IN ('not_dispatched', 'dispatched', 'confirmed', 'failed', 'indeterminate')
	),
	action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
	session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
	generation INTEGER NOT NULL CHECK (generation >= 0),
	observation_ref TEXT CHECK (observation_ref IS NULL OR length(observation_ref) <= 256),
	target_ref TEXT CHECK (target_ref IS NULL OR length(target_ref) <= 256),
	declared_effect TEXT NOT NULL CHECK (
		declared_effect IN ('none', 'navigation', 'input', 'submit', 'unknown')
	),
	approval_ref TEXT CHECK (approval_ref IS NULL OR length(approval_ref) <= 256),
	command_json TEXT NOT NULL CHECK (
		json_valid(command_json) AND json_type(command_json) = 'object'
	),
	-- A digest or marker the host supplied for typed input; the value itself is never stored.
	input_digest TEXT CHECK (input_digest IS NULL OR length(input_digest) <= 128),
	result_code TEXT CHECK (result_code IS NULL OR length(result_code) <= 64),
	retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
	created_at TEXT NOT NULL,
	dispatched_at TEXT,
	settled_at TEXT,
	UNIQUE (run_id, seq),
	CHECK (
		(status IN ('confirmed', 'failed', 'indeterminate')) = (settled_at IS NOT NULL)
	),
	CHECK (
		status NOT IN ('dispatched', 'confirmed', 'indeterminate')
		OR dispatched_at IS NOT NULL
	)
);
CREATE INDEX interact_operations_unsettled ON interact_operations (status)
	WHERE status IN ('dispatched', 'indeterminate');
-- A sent operation never goes back to "not sent": that would make a resend look like a first send.
CREATE TRIGGER interact_operations_no_unsend
BEFORE UPDATE OF status ON interact_operations
WHEN NEW.status = 'not_dispatched' AND OLD.status <> 'not_dispatched'
BEGIN
	SELECT RAISE(ABORT, 'interact_immutable');
END;
CREATE TRIGGER interact_operations_terminal_immutable
BEFORE UPDATE ON interact_operations
WHEN OLD.status IN ('confirmed', 'failed', 'indeterminate')
BEGIN
	SELECT RAISE(ABORT, 'interact_immutable');
END;

CREATE TABLE interact_plan_revisions (
	run_id TEXT NOT NULL REFERENCES interact_runs (run_id) ON DELETE CASCADE,
	revision INTEGER NOT NULL CHECK (revision >= 1),
	reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
	diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
	created_at TEXT NOT NULL,
	PRIMARY KEY (run_id, revision)
);
CREATE TRIGGER interact_plan_revisions_immutable
BEFORE UPDATE ON interact_plan_revisions
BEGIN
	SELECT RAISE(ABORT, 'interact_immutable');
END;

-- What was checked, where, and with what result. Run and operation links are cut (not the row) when
-- the run is forgotten. At least one reference is required when the row is written (checked in code).
CREATE TABLE interact_object_evidence (
	id INTEGER PRIMARY KEY,
	object_id INTEGER NOT NULL REFERENCES interact_site_objects (id) ON DELETE CASCADE,
	candidate_id INTEGER REFERENCES interact_locator_candidates (id) ON DELETE CASCADE,
	object_revision INTEGER NOT NULL CHECK (object_revision >= 1),
	run_id TEXT REFERENCES interact_runs (run_id) ON DELETE SET NULL,
	operation_id TEXT REFERENCES interact_operations (operation_id) ON DELETE SET NULL,
	observation_ref TEXT CHECK (observation_ref IS NULL OR length(observation_ref) <= 256),
	outcome TEXT NOT NULL CHECK (outcome IN ('match', 'mismatch')),
	conditions_json TEXT NOT NULL CHECK (
		json_valid(conditions_json) AND json_type(conditions_json) = 'object'
	),
	checked_at TEXT NOT NULL
);
CREATE INDEX interact_object_evidence_by_object ON interact_object_evidence (object_id, checked_at);
CREATE INDEX interact_object_evidence_by_candidate ON interact_object_evidence (candidate_id, outcome);
`;

export const migrations: readonly string[] = Object.freeze([
	siteAndRunTables.trim() + "\n",
]);

/** Every table the migrations create; `assertInteractSchema` checks these. */
export const INTERACT_TABLES = Object.freeze([
	"interact_site_scopes",
	"interact_page_profiles",
	"interact_site_objects",
	"interact_locator_candidates",
	"interact_object_evidence",
	"interact_workflows",
	"interact_workflow_revisions",
	"interact_runs",
	"interact_operations",
	"interact_plan_revisions",
]);
