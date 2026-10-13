import test from 'node:test';
import assert from 'node:assert/strict';

import { runTests } from '../src/scorm-template/js/test-runner.js';

const testCase = {
  id: 'test-area',
  type: 'function_state',
  points: 100,
  function_name: 'area',
  return_assertion: {
    enabled: true,
    arguments: [3, 4],
    expected_type: 'int',
    value_assertion_enabled: true,
    expected_value: 12,
  },
};

function cannedEngine(functionCalls) {
  let runOptions;
  return {
    get runOptions() {
      return runOptions;
    },
    async run(options) {
      runOptions = options;
      return {
        status: 'done',
        stdout: '',
        functions: {
          area: { exists: true, is_callable: true, param_count: 2, kind: 'function' },
        },
        functionCalls,
      };
    },
  };
}

test('function_state captures and checks configured return calls', async () => {
  const key = JSON.stringify({ functionName: 'area', arguments: [3, 4] });
  const engine = cannedEngine([{ key, ok: true, value: { t: 'int', v: 12 } }]);
  const result = await runTests({ testCases: [testCase], source: 'def area(length, width): return length * width', engine });

  assert.equal(result.allPassed, true);
  assert.equal(result.results[0].passed, true);
  assert.deepEqual(engine.runOptions.capture.function_calls, [{
    key,
    name: 'area',
    arguments: [3, 4],
  }]);
});

test('function_state fails when the configured return call is absent', async () => {
  const engine = cannedEngine([]);
  const result = await runTests({ testCases: [testCase], source: 'def area(length, width): return length * width', engine });

  assert.equal(result.allPassed, false);
  assert.equal(result.results[0].passed, false);
  assert.match(result.results[0].detail, /configured call to area\(3, 4\) did not run/);
});

function responseEngine(response) {
  return {
    async run() {
      return {
        status: 'done',
        stdout: '',
        variables: {},
        functions: {},
        functionCalls: [],
        files: {},
        promptDiagnostics: null,
        ...response,
      };
    },
  };
}

async function runSingleTest(testCase, response) {
  return runTests({
    testCases: [{ points: 100, ...testCase }],
    source: 'pass',
    engine: responseEngine(response),
    requirePreviousTestPass: false,
  });
}

function variableTest(expectedValue, taggedValue) {
  return runSingleTest({
    id: 'variable',
    type: 'variable_state',
    variable_name: 'value',
    value_assertion_enabled: true,
    expected_value: expectedValue,
  }, { variables: { value: taggedValue } });
}

test('variable_state equals distinguishes bools from numbers but equates int and float', async () => {
  assert.equal((await variableTest(1, { t: 'bool', v: true })).results[0].passed, false);
  assert.equal((await variableTest(1, { t: 'int', v: 1 })).results[0].passed, true);
  assert.equal((await variableTest(1, { t: 'float', v: 1.0 })).results[0].passed, true);
  assert.equal((await variableTest(true, { t: 'bool', v: true })).results[0].passed, true);
  assert.equal((await variableTest(true, { t: 'int', v: 1 })).results[0].passed, false);
});

test('variable_state equals compares dictionary keys and values recursively', async () => {
  const actual = {
    t: 'dict',
    v: [[{ t: 'string', v: 'a' }, { t: 'int', v: 1 }]],
  };
  assert.equal((await variableTest({ a: 1 }, actual)).results[0].passed, true);
  assert.equal((await variableTest({ a: 1, b: 2 }, actual)).results[0].passed, false);
});

function csvTest(text, expectedValue = true) {
  return runSingleTest({
    id: 'csv-bool',
    type: 'file_state',
    path: 'result.csv',
    format: 'csv',
    csv_assertions: {
      cells: [{ row: 1, column: 1, expected_type: 'bool', expected_value: expectedValue }],
    },
  }, { files: { 'result.csv': { exists: true, text } } });
}

test('file_state CSV cells recognize Python and lowercase boolean spellings', async () => {
  assert.equal((await csvTest('name,ok\na,True\n')).results[0].passed, true);
  assert.equal((await csvTest('name,ok\na,true\n')).results[0].passed, true);
  assert.equal((await csvTest('name,ok\na,False\n', false)).results[0].passed, true);
  assert.equal((await csvTest('name,ok\na,False\n', true)).results[0].passed, false);
});

test('file_state CSV rejects unsupported boolean spelling with a bool type detail', async () => {
  const result = await csvTest('name,ok\na,TRUE\n');
  assert.equal(result.results[0].passed, false);
  assert.match(result.results[0].detail, /Expected cell \[1\]\[1\] to be bool, got string/);
});

test('function_state checks an expected exception type', async () => {
  const testCase = {
    id: 'test_fn',
    type: 'function_state',
    function_name: 'withdraw',
    return_assertion: {
      enabled: true,
      arguments: [-1],
      expected_error_type: 'ValueError',
    },
  };
  const key = JSON.stringify({ functionName: 'withdraw', arguments: [-1] });
  const functions = {
    withdraw: { exists: true, is_callable: true, param_count: 1, kind: 'function' },
  };

  const expectedError = await runSingleTest(testCase, {
    functions,
    functionCalls: [{ key, ok: false, error: { type: 'ValueError', message: 'negative amount' } }],
  });
  assert.equal(expectedError.results[0].passed, true);

  const wrongError = await runSingleTest(testCase, {
    functions,
    functionCalls: [{ key, ok: false, error: { type: 'TypeError', message: 'wrong failure' } }],
  });
  assert.equal(wrongError.results[0].passed, false);
  assert.match(wrongError.results[0].detail, /to raise ValueError, got TypeError/);

  const returnedNormally = await runSingleTest(testCase, {
    functions,
    functionCalls: [{ key, ok: true, value: { t: 'int', v: -1 } }],
  });
  assert.equal(returnedNormally.results[0].passed, false);
  assert.match(returnedNormally.results[0].detail, /to raise ValueError, but it returned normally/);
});
