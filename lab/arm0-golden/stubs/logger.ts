// Stands in for Eumenes' file-writing logger (`api/infrastructure/logger.ts`) while its pure modules are loaded.
const silent = { debug() {}, info() {}, warn() {}, error() {} };
export const getLogger = () => silent;
