// Capabilities are derived from the authoritative parent record and can
// only decrease. No model role, prompt or repository file can confer rights.
import path from 'node:path';
import { fault } from './execution-contract.mjs';
const ROLE_RIGHTS = Object.freeze({
  researcher: ['read'], reviewer: ['read'], planner: ['read'],
  coder: ['read','edit','checksList','checksRun','spawn'],
  tester: ['read','checksList','checksRun'],
  security: ['read'],
});
const RIGHTS = Object.freeze(['read','edit','checksList','checksRun','spawn']);
const inside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
export function deriveChildCapabilities({ parent, role, requested = [], workspaceScope } = {}) {
  if (!parent || typeof parent !== 'object' || !parent.capabilities ||
      !Object.hasOwn(ROLE_RIGHTS, role) || !Array.isArray(requested) ||
      requested.some(x => !RIGHTS.includes(x)) || !workspaceScope) {
    throw fault('invalid_capabilities', 'Trusted parent, supported role and bounded requested capabilities required.');
  }
  const parentScope = path.resolve(parent.workspaceScope || '');
  const childScope = path.resolve(workspaceScope);
  if (!inside(parentScope, childScope)) throw fault('scope_escalation', 'Worker requested paths outside parent scope.', 403);
  const grants = {};
  const roleRights = new Set(ROLE_RIGHTS[role]);
  const ask = new Set(requested);
  for (const cap of RIGHTS) grants[cap] = parent.capabilities[cap] === true && roleRights.has(cap) && ask.has(cap);
  return Object.freeze({
    ...grants, shell: false, gitWrite: false, integrate: false, publish: false, secrets: false,
    workspaceScope: childScope, role, parentId: parent.id,
  });
}
