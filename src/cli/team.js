'use strict';
// Team mode: one model writes the code, a second one reviews the files it changed. The choice is remembered.
const { c } = require('./theme');
const input = require('./input');
const { parseSpec, specName, pickModel, testModel, runTests } = require('./models');

const read = (host) => ({ on: false, coder: null, reviewer: null, ...(host.readState().team || {}) });
const write = (host, team) => { host.saveState({ team }); return team; };

// put a team on a running session (or take it off)
function apply(rt, team) { rt.team = !!(team.on && team.reviewer); rt.coder = team.coder || null; rt.reviewer = team.reviewer || null; }

// the team for a new session: the saved one, changed by --team / --coder / --reviewer
function fromFlags(host, o) {
  const team = read(host);
  if (o.coder) team.coder = parseSpec(o.coder);
  if (o.reviewer) team.reviewer = parseSpec(o.reviewer);
  if (o.coder || o.reviewer || o.team) team.on = true;
  if (o.team === false) team.on = false;
  if ((o.team || o.coder || o.reviewer) && !team.reviewer) throw new Error('Team mode needs a reviewer model: add --reviewer provider/model, or run: caelix team');
  return team;
}

function describe(team, say) {
  say(`  Team mode ${team.on && team.reviewer ? c.green('on') : c.dim('off')}`);
  say(c.dim('  coder     ') + (team.coder ? specName(team.coder) : 'the session model'));
  say(c.dim('  reviewer  ') + specName(team.reviewer));
}

// verbs shared by `caelix team …` and `/team …`
async function command(host, args, { say = (s) => process.stdout.write(s + '\n'), interactive = !!process.stdin.isTTY } = {}) {
  const [verb, a, b] = args; let team = read(host);
  const done = () => { write(host, team); describe(team, say); return team; };
  const needReviewer = () => { if (!team.reviewer) throw new Error('Choose a reviewer first: team reviewer provider/model'); };
  const test = async () => {
    const targets = [team.coder, team.reviewer].filter(Boolean);
    if (!targets.length) throw new Error('No team models to test yet.');
    await runTests(host, targets, { say });
  };

  if (verb === 'status' || (!verb && !interactive)) { describe(team, say); return team; }
  if (verb === 'on') { needReviewer(); team.on = true; return done(); }
  if (verb === 'off') { team.on = false; return done(); }
  if (verb === 'coder') {
    if (a === 'same') team.coder = null; else if (a) team.coder = parseSpec(a); else if (interactive) team.coder = (await pickModel(host, 'Provider for the CODER', say)) || team.coder; else throw new Error('Usage: team coder provider/model (or "same")');
    return done();
  }
  if (verb === 'reviewer') {
    if (a) team.reviewer = parseSpec(a); else if (interactive) team.reviewer = (await pickModel(host, 'Provider for the REVIEWER', say)) || team.reviewer; else throw new Error('Usage: team reviewer provider/model');
    team.on = !!team.reviewer;
    return done();
  }
  if (verb === 'set') {
    if (!a || !b) throw new Error('Usage: team set <coder provider/model> <reviewer provider/model>');
    team = { on: true, coder: parseSpec(a), reviewer: parseSpec(b) }; return done();
  }
  if (verb === 'test') { await test(); return team; }
  if (verb) throw new Error('Use: team [status | on | off | coder <p/m> | reviewer <p/m> | set <coder> <reviewer> | test]');

  // menu
  let at = 0;
  for (;;) {
    const on = team.on && team.reviewer;
    at = await input.select(`Team mode (${on ? 'on' : 'off'}): one model writes, another reviews`, [
      { label: 'Coder', hint: team.coder ? specName(team.coder) : 'the session model' },
      { label: 'Reviewer', hint: specName(team.reviewer) },
      { label: on ? 'Turn team mode off' : 'Turn team mode on', hint: team.reviewer ? '' : 'choose a reviewer first' },
      { label: 'Test the team models' },
      { label: 'Done' },
    ], { start: Math.max(0, at) });
    if (at < 0 || at === 4) break;
    try {
      if (at === 0) team.coder = (await pickModel(host, 'Provider for the CODER', say)) || team.coder;
      else if (at === 1) { const r = await pickModel(host, 'Provider for the REVIEWER', say); if (r) { team.reviewer = r; team.on = true; say(c.dim('  checking ' + specName(r) + '…')); const t = await testModel(host, r, { tools: false }); if (!t.ok) say(c.amber(`  Warning: ${specName(r)} did not answer (${t.verdict}).`)); } }
      else if (at === 2) { if (on) team.on = false; else { needReviewer(); team.on = true; } }
      else await test();
    } catch (e) { say(c.red('  ' + e.message)); }
    write(host, team);
  }
  return done();
}

module.exports = { read, write, apply, fromFlags, describe, command };
