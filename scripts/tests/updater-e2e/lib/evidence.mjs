// What the proof keeps and says: a line for every step with the time it took, a PASS line for every fact it checked (the CI log shows each phase and each check), the screenshots and diagnostics a failure
// needs, and report.json at the end (uploaded as an artifact, so that a red run can be read without the machine). A check that fails stops the run at once, with the facts around it.
import fs from 'node:fs';
import path from 'node:path';

export class Evidence {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.started = Date.now();
    this.checks = [];
    this.phases = [];
    this.notes = {};
    this.currentPhase = null;
  }

  elapsed() { return ((Date.now() - this.started) / 1000).toFixed(1).padStart(7); }

  /** A line of the log, with the time since the start. */
  log(line) { console.log(`[${this.elapsed()}s] ${line}`); }

  /** The start of a phase: a heading in the log, and the time it takes is kept. */
  phase(name, summary) {
    if (this.currentPhase) this.currentPhase.seconds = Number(((Date.now() - this.currentPhase.began) / 1000).toFixed(1));
    this.currentPhase = { name, summary, began: Date.now(), seconds: null };
    this.phases.push(this.currentPhase);
    console.log(`\n[${this.elapsed()}s] ===== PHASE ${name}: ${summary} =====`);
  }

  /** A fact that must hold. PASS is printed and kept; a fact that does not hold stops the run with its label. */
  check(condition, label, detail) {
    if (!condition) {
      this.checks.push({ label, ok: false, detail: detail === undefined ? null : String(detail).slice(0, 1000), at: this.elapsed().trim() });
      console.log(`[${this.elapsed()}s] FAIL ${label}${detail === undefined ? '' : `\n         ${String(detail).slice(0, 1000)}`}`);
      throw new Error(`FAILED: ${label}${detail === undefined ? '' : ` (${String(detail).slice(0, 300)})`}`);
    }
    this.checks.push({ label, ok: true, at: this.elapsed().trim() });
    console.log(`[${this.elapsed()}s] PASS ${label}`);
  }

  /** A value worth keeping for whoever reads the report (versions, ids, durations); it is not a check. */
  note(name, value) { this.notes[name] = value; this.log(`note ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }

  file(name) { return path.join(this.directory, name); }
  write(name, text) { fs.writeFileSync(this.file(name), text); }

  finish(outcome, error = null) {
    if (this.currentPhase) this.currentPhase.seconds = Number(((Date.now() - this.currentPhase.began) / 1000).toFixed(1));
    const report = {
      outcome, error: error ? String(error.stack ?? error).slice(0, 4000) : null, seconds: Number(((Date.now() - this.started) / 1000).toFixed(1)),
      phases: this.phases.map(({ name, summary, seconds }) => ({ name, summary, seconds })), notes: this.notes, checks: this.checks,
    };
    this.write('report.json', `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
}
