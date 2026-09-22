/**
 * A SCORM 1.2 runtime for the browser tests, backed by localStorage so it
 * survives a reload the way a real LMS session does.
 *
 * Everything the runtime writes is visible to the test afterwards: the data
 * model itself, a commit counter, and a snapshot of what the last commit
 * carried (which is how "one commit per Check" is asserted).
 */

const STORAGE_KEY = 'mock-scorm-model';

/** The init script must be self-contained: it is serialised into the page. */
export const MOCK_SCORM_INIT = ({ seedModel = {} } = {}) => {
  const key = 'mock-scorm-model';

  if (!localStorage.getItem(key)) {
    localStorage.setItem(key, JSON.stringify(seedModel));
  }

  const read = () => JSON.parse(localStorage.getItem(key) || '{}');
  const write = (model) => localStorage.setItem(key, JSON.stringify(model));
  const cmiSnapshot = (model) => Object.fromEntries(
    Object.entries(model).filter(([name]) => name.startsWith('cmi.')),
  );

  window.API = {
    LMSInitialize() {
      const model = read();
      model.__initializes = (model.__initializes || 0) + 1;
      write(model);
      return 'true';
    },
    LMSGetValue(name) {
      return read()[name] ?? '';
    },
    LMSSetValue(name, value) {
      const model = read();
      if (name === 'cmi.suspend_data') {
        if (model.__rejectSuspendData) return 'false';
        const limit = model.__suspendDataLimit;
        model[name] = limit ? String(value).slice(0, limit) : String(value);
      } else {
        model[name] = String(value);
      }
      write(model);
      return 'true';
    },
    LMSCommit() {
      const model = read();
      model.__commits = (model.__commits || 0) + 1;
      model.__lastCommit = cmiSnapshot(model);
      write(model);
      return 'true';
    },
    LMSFinish() {
      const model = read();
      model.__finishes = (model.__finishes || 0) + 1;
      write(model);
      return 'true';
    },
    LMSGetLastError() {
      return '0';
    },
    LMSGetErrorString() {
      return 'No error';
    },
    LMSGetDiagnostic() {
      return '';
    },
  };
};

/** Read the mock runtime's data model out of a page. */
export function readLmsModel(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), STORAGE_KEY);
}

/**
 * Seed the mock runtime's data model before the activity loads. Register this
 * *before* `MOCK_SCORM_INIT`, which only fills in a model that does not exist
 * yet.
 */
export const SEED_MODEL_INIT = ({ model = {} } = {}) => {
  localStorage.setItem('mock-scorm-model', JSON.stringify(model));
};
