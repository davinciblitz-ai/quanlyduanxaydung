(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FleetMotion=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
function route(points){let length=0;const segments=points.slice(1).map((b,i)=>{const a=points[i],size=Math.hypot(b[0]-a[0],b[1]-a[1]),start=length;length+=size;return {a,b,size,start};});return {length,at(distance,direction=1){distance=Math.max(0,Math.min(length,distance));const s=segments.find(s=>distance<=s.start+s.size)||segments.at(-1),q=s.size?(distance-s.start)/s.size:0;return {x:s.a[0]+(s.b[0]-s.a[0])*q,z:s.a[1]+(s.b[1]-s.a[1])*q,yaw:Math.atan2(-(s.b[1]-s.a[1])*direction,(s.b[0]-s.a[0])*direction)};}};}
function advance(state,path,wanted,dt,{reduced=false,paused=false,speed=2.6}={}){state.distance??=0;const goal=wanted?path.length:0,delta=goal-state.distance,direction=Math.sign(delta)||state.direction||1;state.direction=direction;if(reduced)state.distance=goal;else if(!paused)state.distance+=Math.sign(delta)*Math.min(Math.abs(delta),Math.max(0,dt)*speed);return {...path.at(state.distance,direction),visible:state.distance>0.0001,parked:wanted&&Math.abs(state.distance-path.length)<.001,travel:state.distance/path.length};}
function overlaps(a,b,gap=.04){if(a.visible===false||b.visible===false)return false;const axes=p=>[[Math.cos(p.yaw||0),-Math.sin(p.yaw||0)],[Math.sin(p.yaw||0),Math.cos(p.yaw||0)]],aa=axes(a),bb=axes(b),dx=b.x-a.x,dz=b.z-a.z;for(const axis of [...aa,...bb]){const radius=(p,ax)=>(p.length+gap)/2*Math.abs(ax[0][0]*axis[0]+ax[0][1]*axis[1])+(p.width+gap)/2*Math.abs(ax[1][0]*axis[0]+ax[1][1]*axis[1]);if(Math.abs(dx*axis[0]+dz*axis[1])>=radius(a,aa)+radius(b,bb))return false;}return true;}
function reserve(registry,key,pose,size){const candidate={...pose,...size};if(!pose.visible){registry.set(key,candidate);return true;}for(const [id,other]of registry)if(id!==key&&overlaps(candidate,other))return false;registry.set(key,candidate);return true;}
function deploy(state,paths,wanted,dt,{reduced=false,paused=false,speed=2.1,accept=()=>true}={}){
 state.phase??='idle';state.distance??=0;const before={...state};
 if(reduced){state.phase=wanted?'work':'idle';state.distance=wanted?paths.in.length:0;}
 else if(state.phase==='idle'&&wanted){state.phase='enter';state.distance=0;}
 if(state.phase==='work'&&!wanted){state.phase='exit';state.distance=0;}
 const path=state.phase==='exit'?paths.out:paths.in;
 if(!paused&&!reduced&&(state.phase==='enter'||state.phase==='exit')){state.distance=Math.min(path.length,state.distance+Math.max(0,dt)*speed);if(state.distance>=path.length){state.phase=state.phase==='enter'?'work':'idle';if(state.phase==='idle')state.distance=0;}}
 const activePath=state.phase==='exit'?paths.out:paths.in;
 const pose={...activePath.at(state.phase==='work'?paths.in.length:state.distance),visible:state.phase!=='idle',parked:state.phase==='work',phase:state.phase};
 if(!accept(pose)){Object.assign(state,before);return {...(state.pose||{...paths.in.at(0),visible:false}),waiting:true};}
 state.pose=pose;return pose;
}
function turnAngle(current,target,dt,speed=2.4){const delta=Math.atan2(Math.sin(target-current),Math.cos(target-current));return current+Math.sign(delta)*Math.min(Math.abs(delta),Math.max(0,dt)*speed);}
return {route,advance,overlaps,reserve,deploy,turnAngle};
});
