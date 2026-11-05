/**
 * `eumenes-interact/sqlite`: migrations and synchronous store functions on a host-owned connection.
 * The host owns the connection, transactions, PRAGMAs (foreign keys on) and the clock; every writer
 * refuses outside a transaction and takes ISO timestamps as arguments.
 */
export { migrations, INTERACT_TABLES } from "./migrations.ts";
export { forgetSiteScope } from "./site-knowledge.ts";
export {
	putSearchTemplate,
	getSearchUrl,
	type SearchTemplate,
} from "./search-templates.ts";
export { assertInteractSchema } from "./schema-check.ts";
export {
	InteractStoreError,
	STORE_ERROR_CODES,
	isInteractStoreError,
} from "./errors.ts";
export type { StoreErrorCode } from "./errors.ts";
export {
	RUN_STATUSES,
	RUN_TRANSITIONS,
	TERMINAL_RUN_STATUSES,
	createRun,
	getRun,
	isTerminalRunStatus,
	listPlanRevisions,
	listRuns,
	recordPlanRevision,
	saveCoreState,
	transitionRun,
} from "./runs.ts";
export type {
	CreateRunInput,
	PlanRevision,
	RunRecord,
	RunStatus,
} from "./runs.ts";
export {
	OPERATION_TRANSITIONS,
	getOperation,
	listOperations,
	listUnsettledOperations,
	markOperationDispatched,
	recordOperationIntent,
	redactCommand,
	settleOperation,
} from "./operations.ts";
export type { OperationRecord, SettledStatus } from "./operations.ts";
export {
	CANDIDATE_KINDS,
	CANDIDATE_STATUSES,
	addLocatorCandidate,
	findSiteObjects,
	getSiteObject,
	getSiteScope,
	listEvidence,
	listPageProfiles,
	recordEvidence,
	setCandidateStatus,
	upsertPageProfile,
	upsertSiteScope,
	writeSiteObject,
} from "./site-knowledge.ts";
export type {
	CandidateInput,
	CandidateKind,
	CandidateRecord,
	CandidateStatus,
	EvidenceInput,
	EvidenceRecord,
	FlatFields,
	PageProfile,
	PageProfileInput,
	SiteObjectView,
	SiteScope,
	WriteSiteObjectInput,
} from "./site-knowledge.ts";
export {
	getLatestWorkflowRevision,
	getWorkflowRevision,
	registerWorkflowRevision,
} from "./workflows.ts";
export type { WorkflowRevision, WorkflowRevisionInput } from "./workflows.ts";
