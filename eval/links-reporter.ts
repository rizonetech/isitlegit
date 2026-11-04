import type { Reporter, TestCase } from "vitest/node";
// Vitest transports task metadata even when successful-test console output is suppressed.
export default class LinksReporter implements Reporter {
  onTestCaseResult(testCase: TestCase) {
    const results = (testCase.meta() as { linkResults?: unknown }).linkResults;
    if (results !== undefined) process.stdout.write(`LINK_RESULTS=${JSON.stringify(results)}\n`);
  }
}
