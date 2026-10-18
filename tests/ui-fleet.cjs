const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.PW_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:4193');await page.waitForFunction(()=>window.Nen);
  const report=await page.evaluate(()=>{
   const s=[...BuildScene.instances][0],render=s.renderer.render.bind(s.renderer);s.renderer.render=()=>{};s.reduced=false;
   let target=.06;s.getProgress=()=>target;s.deployments={pump:{},excavator:{},roller:{},mixer:{}};s.pumpExtension=0;s.vehicleRegistry.clear();s.traffic.forEach(v=>{v.active=false;v.distance=0;});
   const collisions=[],jumps=[],supplyErrors=[],segments=[],previous=new Map();
   for(const value of [.06,.235,.335,.307,.65,.06]){
    target=value;let supplied=0;
    for(let frame=0;frame<1000;frame++){
     s.dirty=true;s.draw(s.lastTime+50);
     const objects=new Map([['truck0',s.mixer.group],['truck1',s.dumper.group],['pump',s.pump.group],['excavator',s.excavator.group],['roller',s.roller.group],...s.ambientCars.map((c,i)=>['street'+i,c.group])]);
     const bodies=[...s.vehicleRegistry].map(([key,shape])=>{const o=objects.get(key);return {key,...shape,x:o.position.x,z:o.position.z,yaw:o.rotation.y,visible:o.visible};});
     for(let a=0;a<bodies.length;a++)for(let b=a+1;b<bodies.length;b++)if(FleetMotion.overlaps(bodies[a],bodies[b],0))collisions.push({value,frame,a:bodies[a].key,b:bodies[b].key});
     for(const body of bodies){const old=previous.get(body.key);if(old?.visible&&body.visible&&Math.hypot(old.x-body.x,old.z-body.z)>.17)jumps.push({key:body.key,value,frame});previous.set(body.key,body);}
     if(s.lastScene.machines.pouring){supplied++;if(!s.mixer.group.visible||!s.mixer.feed.visible||s.deployments.mixer.phase!=='work'||s.deployments.pump.phase!=='work'||Math.abs(Math.cos(s.mixer.group.rotation.y-s.pump.group.rotation.y)+1)>.001)supplyErrors.push({value,frame});}
     if(frame>800&&(value===.307||value===.65)&&!s.lastScene.machines.pouring)supplyErrors.push({value,frame,reason:'supply interrupted'});
    }
    segments.push({value,supplied,states:JSON.parse(JSON.stringify(s.deployments)),visible:[['pump',s.pump.group],['excavator',s.excavator.group],['roller',s.roller.group],['mixer',s.mixer.group],['dumper',s.dumper.group]].filter(([,o])=>o.visible).map(([k])=>k)});
   }
   s.renderer.render=render;return {collisions,jumps,supplyErrors,segments};
  });
  fs.writeFileSync('test-results/fleet-trajectory.json',JSON.stringify(report,null,2));
  assert.deepEqual(report.collisions,[],'Vehicle bodies overlap');assert.deepEqual(report.jumps,[],'Vehicles teleport');assert.deepEqual(report.supplyErrors,[],'Pump requires continuous rear-to-rear mixer supply');
  assert.deepEqual(report.segments[0].visible,[]);assert.deepEqual(report.segments.at(-1).visible,[]);
  console.log('PASS 300 simulated seconds: all vehicle bodies separated, continuous entry/exit, prep empty, rear-to-rear mixer feeds pump throughout both pours.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
