/**
 * Activity config fixtures.
 *
 * `activityConfig()` is the smallest config that passes `validateConfig`, so
 * tests can override exactly the field they are probing and leave everything
 * else in a known-good state.
 */

/** Minimal publishable config: one stdout test. */
export function activityConfig(overrides = {}) {
  return deepMerge(
    {
      metadata: {
        activity_id: 'test_activity',
        title: 'Test Activity',
        version: '1.0',
        description: '',
      },
      instructions: { main: '', steps: [] },
      ui_settings: {
        show_hint_panel: true,
        suspend_data_limit: 4096,
      },
      python_setup: {
        starter_code: '',
        files: [],
        packages: [],
        pyodide_base_url: '',
      },
      hints: [],
      evaluation: {
        require_previous_test_pass: true,
        feedback_on_all_pass: '',
        test_cases: [
          {
            id: 'test_print',
            type: 'stdout_match',
            points: 10,
            output_assertion: { enabled: true, expected: 'hi\n', match_mode: 'exact' },
          },
        ],
      },
    },
    overrides,
  );
}

/** A config whose single test grades source structure via a condition. */
export function codeStructureTestConfig(condition, { id = 'test_structure', points = 10 } = {}) {
  return activityConfig({
    evaluation: {
      test_cases: [
        {
          id,
          type: 'code_structure',
          points,
          conditions: condition,
        },
      ],
    },
  });
}

/** A hint config with the given trigger overrides. */
export function hint(overrides = {}) {
  return deepMerge(
    {
      id: 'hint_1',
      trigger: { event: 'code_change', conditions: { type: 'source_empty' } },
      display_mode: 'triggered',
      message: 'Try something.',
      priority: 1,
      delay_seconds: 0,
      show_once: false,
    },
    overrides,
  );
}

/** Recursive merge; arrays and scalars in `patch` replace the base value. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
