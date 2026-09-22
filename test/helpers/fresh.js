/**
 * Import a module with a fresh instance.
 *
 * Several runtime modules keep session state at module scope (the SCORM
 * session, the hint state, the persistence queue). Tests that assert on that
 * state need their own instance, so they import through here instead of the
 * module registry.
 */

let counter = 0;

export function freshModule(specifier) {
  counter += 1;
  const separator = specifier.includes('?') ? '&' : '?';
  return import(`${specifier}${separator}fresh=${counter}`);
}
