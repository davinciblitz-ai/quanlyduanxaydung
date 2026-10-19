const assert=require('assert/strict'),{spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm'),crypto=require('crypto'),CT=require('../engine.js');const ctx={window:{},crypto,CT};vm.runInNewContext(fs.readFileSync(require.resolve('../samples.js'),'utf8'),ctx);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qlda-collab-')),proc=spawn(process.execPath,[require.resolve('../server.cjs')],{env:{...process.env,PORT:'4189',NEN_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',x=>output+=x);proc.stderr.on('data',x=>output+=x);async function api(route,method='GET',body,cookie=''){const r=await fetch('http://127.0.0.1:4189'+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
(async()=>{try{for(let i=0;!output.includes('đang chạy')&&i<100;i++)await new Promise(r=>setTimeout(r,50));const owner=await api('/api/setup','POST',{name:'Owner',email:'owner@qlda.test',password:'Test-only-4567'});assert.equal(owner.status,201);const p=ctx.window.Samples.group();assert.equal((await api('/api/projects','POST',{project:p},owner.cookie)).status,201);const people={};for(const role of['viewer','commenter','editor']){const inv=await api('/api/projects/'+p.id+'/invites','POST',{role},owner.cookie);assert.equal(inv.status,201,JSON.stringify(inv.body));const token=inv.body.token;assert.equal((await api('/api/invites/'+token)).status,200);const joined=await api('/api/invites/'+token,'POST',{name:role,email:role+'@qlda.test',password:'Test-only-4567'});assert.equal(joined.status,200,JSON.stringify(joined.body));people[role]=joined;assert.equal((await api('/api/invites/'+token)).status,404);assert.equal((await api('/api/projects/'+p.id,'GET',undefined,joined.cookie)).body.project._role,role);}
assert.equal((await api('/api/projects/'+p.id+'/comments','POST',{body:'<img src=x onerror=1> Bình luận\nDòng hai'},people.commenter.cookie)).status,201);assert.equal((await api('/api/projects/'+p.id+'/comments','POST',{body:'viewer cannot'},people.viewer.cookie)).status,403);assert.equal((await api('/api/projects/'+p.id,'PUT',{project:p,version:1},people.commenter.cookie)).status,403);assert.equal((await api('/api/projects/'+p.id+'/comments','GET',undefined,people.viewer.cookie)).body.comments[0].body,'<img src=x onerror=1> Bình luận\nDòng hai');p.name='nhóm quản lý dự án';assert.equal((await api('/api/projects/'+p.id,'PUT',{project:p,version:1},people.editor.cookie)).status,200);assert.equal((await api('/api/projects/'+p.id+'/invites','POST',{role:'editor'},people.editor.cookie)).status,403);assert.equal((await api('/api/projects/'+p.id+'/invites','POST',{role:'owner'},owner.cookie)).status,400);assert.equal((await api('/api/projects/'+p.id+'/members','POST',{userId:people.commenter.body.user.id,role:'viewer'},owner.cookie)).status,200);assert.equal((await api('/api/projects/'+p.id+'/comments','POST',{body:'old commenter'},people.commenter.cookie)).status,403);
for(const role of['viewer','commenter','editor'])assert.equal((await api('/api/projects/'+p.id,'DELETE',{version:2},people[role].cookie)).status,403);
assert.equal((await api('/api/projects/'+p.id,'DELETE',{version:1},owner.cookie)).status,409);
assert.equal((await api('/api/projects/'+p.id,'DELETE',{version:2},owner.cookie)).status,200);
assert.equal((await api('/api/projects/'+p.id,'GET',undefined,owner.cookie)).status,404);
assert.equal((await api('/api/projects/'+p.id+'/comments','POST',{body:'deleted'},people.editor.cookie)).status,404);
assert.equal((await api('/api/deleted-projects','GET',undefined,owner.cookie)).body.projects.length,1);
assert.equal((await api('/api/projects/'+p.id+'/restore','POST',{},people.editor.cookie)).status,403);
assert.equal((await api('/api/projects/'+p.id+'/restore','POST',{},owner.cookie)).status,200);
assert.equal((await api('/api/projects/'+p.id,'GET',undefined,owner.cookie)).body.project._version,4);

// --- Who can see whom: non-admins only see people they share a project with.
const route='/api/projects/'+p.id,ownerId=owner.body.user.id;
const ids=Object.fromEntries(Object.entries(people).map(([role,joined])=>[role,joined.body.user.id]));
const byId=(a,b)=>a-b;
assert.deepEqual((await api('/api/users','GET',undefined,people.editor.cookie)).body.users.map(u=>u.id).sort(byId),[ownerId,ids.viewer,ids.commenter,ids.editor].sort(byId));

// --- Member removal: owners remove others, anyone may leave, the original owner stays.
assert.equal((await api(route+'/members/'+ids.commenter,'DELETE',undefined,people.viewer.cookie)).status,403);
assert.equal((await api(route+'/members/'+ids.commenter,'DELETE',undefined,owner.cookie)).status,200);
assert.equal((await api(route,'GET',undefined,people.commenter.cookie)).status,403);
assert.equal((await api(route+'/members/'+ids.commenter,'DELETE',undefined,owner.cookie)).status,404);
assert.equal((await api(route+'/members/'+ownerId,'DELETE',undefined,owner.cookie)).status,400);
assert.equal((await api(route+'/members/'+ids.viewer,'DELETE',undefined,people.viewer.cookie)).status,200);
assert.equal((await api(route,'GET',undefined,people.viewer.cookie)).status,403);
assert.ok((await api(route+'/audit','GET',undefined,owner.cookie)).body.events.some(e=>e.action==='Xóa thành viên tài khoản #'+ids.commenter));

// --- Co-owners: cannot demote/remove each other or the original owner, cannot delete the project.
assert.equal((await api(route+'/members','POST',{userId:ids.editor,role:'owner'},owner.cookie)).status,200);
assert.equal((await api(route+'/members','POST',{userId:ids.commenter,role:'owner'},owner.cookie)).status,200);
assert.equal((await api(route+'/members','POST',{userId:ids.commenter,role:'viewer'},people.editor.cookie)).status,403);
assert.equal((await api(route+'/members/'+ids.commenter,'DELETE',undefined,people.editor.cookie)).status,403);
assert.equal((await api(route+'/members','POST',{userId:ownerId,role:'editor'},people.editor.cookie)).status,400);
assert.equal((await api(route+'/members/'+ownerId,'DELETE',undefined,people.editor.cookie)).status,400);
const liveVersion=(await api(route,'GET',undefined,owner.cookie)).body.project._version;
assert.equal((await api(route,'DELETE',{version:liveVersion},people.editor.cookie)).status,403);

// --- Inviter re-check: an invite made by a co-owner dies when that co-owner is demoted.
const coInvite=await api(route+'/invites','POST',{role:'viewer'},people.editor.cookie);
assert.equal(coInvite.status,201);
assert.equal((await api(route+'/members','POST',{userId:ids.editor,role:'editor'},owner.cookie)).status,200);
assert.equal((await api('/api/invites/'+coInvite.body.token,'POST',{name:'Late',email:'late@qlda.test',password:'Test-only-4567'})).status,410);
assert.equal((await api('/api/invites/'+coInvite.body.token)).status,404);
assert.equal((await api('/api/login','POST',{email:'late@qlda.test',password:'Test-only-4567'})).status,401,'no account created');

// --- Invite listing and revocation (owners only; raw tokens are never listed).
const pending=await api(route+'/invites','POST',{role:'commenter'},owner.cookie);
assert.equal(pending.status,201);
const listed=(await api(route+'/invites','GET',undefined,owner.cookie)).body.invites;
assert.ok(listed.some(i=>i.id===pending.body.id&&i.role==='commenter'&&i.creator==='Owner'));
assert.ok(!JSON.stringify(listed).includes(pending.body.token));
assert.equal((await api(route+'/invites','GET',undefined,people.editor.cookie)).status,403);
assert.equal((await api(route+'/invites/'+pending.body.id,'DELETE',undefined,people.editor.cookie)).status,403);
assert.equal((await api(route+'/invites/'+pending.body.id,'DELETE',undefined,owner.cookie)).status,200);
assert.equal((await api('/api/invites/'+pending.body.token)).status,404);
assert.equal((await api(route+'/invites/'+pending.body.id,'DELETE',undefined,owner.cookie)).status,404);

// --- Only the original owner manages another owner's role.
assert.equal((await api(route+'/members','POST',{userId:ids.commenter,role:'viewer'},owner.cookie)).status,200);
console.log('✓ Thành viên: xem tài khoản theo dự án, xóa/rời dự án, giới hạn owner phụ, thu hồi lời mời, kiểm tra lại người mời.');
console.log('✓ Mời dùng một lần, tạo tài khoản qua lời mời, viewer/commenter/editor, lưu bình luận và từ chối sửa dữ liệu/bình luận sai quyền.');}catch(e){console.error(e);console.error(output);process.exitCode=1}finally{proc.kill();proc.once('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));}})();
