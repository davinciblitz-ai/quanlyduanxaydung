// Browser check of the 3D site vehicles (run through tests/browser.test.cjs, server on port 4193).
const { chromium } = require('playwright'), assert = require('node:assert/strict'), fs = require('node:fs');

// Runs inside the page: drives the hero scene frame by frame through a sequence of construction steps.
function inspectFleet() {
  const s = [...BuildScene.instances][0], render = s.renderer.render.bind(s.renderer);
  s.renderer.render = () => {};
  s.reduced = false;
  const steps = ConstructionSequence.steps;
  let target = steps[0].p;
  s.getProgress = () => target;
  const report = { collisions: [], teleports: [], supplyErrors: [], spin: [], segments: [] }, previous = new Map();
  for (const [index, frames] of [[0, 120], [2, 900], [6, 900], [10, 700], [20, 900], [0, 200]]) {
    target = steps[index].p;
    let pouring = 0, counted = 0;
    for (let frame = 0; frame < frames; frame++) {
      s.dirty = true;
      s.draw(s.lastTime + 50);
      const out = s.fleet.output().filter(v => v.visible), meshes = s.vehicleMeshes;
      for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++)
        if (FleetMotion.overlaps(out[a], out[b], 0)) report.collisions.push({ index, frame, a: out[a].id, b: out[b].id });
      for (const v of out) {
        const g = meshes.get(v.id).group, old = previous.get(v.id);
        // Smooth motion: a fully visible vehicle never jumps between frames (placements fade in from 0).
        if (old && old.alpha > 0.99 && v.alpha > 0.99 && Math.hypot(old.x - g.position.x, old.z - g.position.z) > 0.17) report.teleports.push({ id: v.id, index, frame });
        const wheel = meshes.get(v.id).wheels[0];
        if (old && wheel && v.mode === 'drive' && v.gear && Math.abs(v.odo - old.odo) > 1e-4) {
          const turned = wheel.spin.rotation.z - old.spin;
          if (Math.sign(turned) !== -Math.sign(v.gear)) report.spin.push({ id: v.id, index, frame });
        }
        previous.set(v.id, { x: g.position.x, z: g.position.z, alpha: v.alpha, odo: v.odo, spin: wheel ? wheel.spin.rotation.z : 0 });
      }
      for (const id of previous.keys()) if (!out.some(v => v.id === id)) previous.delete(id);
      // Concrete only flows pump ← mixer, rear to rear, with the chute feed and the hose stream showing.
      if (s.lastScene.machines.pouring) {
        if (frame > 60) pouring++;
        const mixer = out.find(v => v.kind === 'mixer' && v.docked), pump = out.find(v => v.kind === 'pump');
        const pumpMesh = pump && meshes.get(pump.id), mixerMesh = mixer && meshes.get(mixer.id);
        if (!mixer || !pump || !mixerMesh.feed.visible || !pumpMesh.stream.visible || Math.abs(Math.cos(mixer.yaw - pump.yaw) + 1) > 1e-3) report.supplyErrors.push({ index, frame });
      }
      if (frame > 60) counted++;
    }
    report.segments.push({ index, step: s.fleet.applied, pouringShare: counted ? pouring / counted : 0, visible: s.fleet.output().filter(v => v.visible).map(v => v.kind) });
  }
  s.renderer.render = render;
  return report;
}

if (require.main === module) (async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:4193');
    await page.waitForFunction(() => window.Nen && [...BuildScene.instances][0]?.fleet);
    const report = await page.evaluate(inspectFleet);
    fs.writeFileSync('test-results/fleet-trajectory.json', JSON.stringify(report, null, 2));
    assert.deepEqual(report.collisions, [], 'Vehicle bodies overlap');
    assert.deepEqual(report.teleports, [], 'Vehicles teleport');
    assert.deepEqual(report.spin, [], 'Wheels spin against the direction of travel');
    assert.deepEqual(report.supplyErrors, [], 'Pump must be fed rear to rear by a docked mixer');
    const by = i => report.segments.find(g => g.index === i);
    assert.deepEqual(report.segments[0].visible, [], 'site preparation has no machines');
    assert.deepEqual(report.segments.at(-1).visible, [], 'machines leave when the work is done');
    assert.ok(by(2).visible.includes('excavator') && by(2).visible.includes('dumper'), 'excavation: excavator and dump trucks');
    assert.ok(by(10).visible.includes('roller'), 'compaction: roller');
    for (const i of [6, 20]) assert.ok(by(i).pouringShare > 0.35, 'pour step ' + i + ' actually pours (' + by(i).pouringShare + ')');
    console.log('PASS site vehicles: no overlap or jumps, wheels roll with the gear, pump fed rear to rear, machines follow the construction step.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { inspectFleet };
