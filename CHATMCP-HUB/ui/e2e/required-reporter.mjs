// A missing prerequisite must not turn a required UI gate green through test.skip().
export default class RequiredReporter {
  onBegin(_config, suite) { this.tests = suite.allTests(); }
  onEnd() {
    const skipped = (this.tests ?? []).filter((test) => test.results.length === 0 || test.results.some((result) => result.status === 'skipped'));
    if (!this.tests?.length || skipped.length) {
      console.error(`Required React E2E gate: ${skipped.length} skipped, ${this.tests?.length ?? 0} discovered.`);
      return { status: 'failed' };
    }
  }
}
