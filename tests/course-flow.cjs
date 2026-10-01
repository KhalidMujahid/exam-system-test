const assert=require('node:assert/strict');
const crypto=require('crypto');
const {createFixture}=require('./flow-fixture.cjs');
(async()=>{
 const {app,state,adminToken}=createFixture();
 const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(url,options={})=>fetch(base+url,{redirect:'manual',...options});
 const post=(url,data,cookie='')=>request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',origin:'http://localhost:3000',cookie},body:new URLSearchParams(data)});
 try {
  const portal=await request('/portal').then(r=>r.text()); assert.ok(!portal.includes('value="course-1"')); assert.ok(portal.includes('value="course-2"'));
  const certs=await request('/certifications').then(r=>r.text());assert.ok(certs.includes('/certifications/course-1/checkout'));assert.ok(!certs.includes('/certifications/course-2/checkout'));
  const checkout=await request('/certifications/course-1/checkout').then(r=>r.text());assert.ok(checkout.includes('name="email"'));assert.ok(!checkout.includes('name="institution"'));
  const purchase=await post('/checkout',{courseId:'course-1',email:'student@example.com',name:'Ignored before payment',institution:'Ignored'});assert.equal(purchase.status,302);assert.equal(state.attempts.length,0);
  const payment=state.payments[0], path='/courses/access/'+payment.reference;
  assert.equal(payment.candidateName,'');assert.equal(payment.institution,'');
  assert.equal((await request(path)).status,403);
  for(const id of [0,1]) {
    for(const action of ['open','download']) assert.equal((await request('/materials/'+action+'/material-'+id)).status,302);
  }
  assert.equal((await request('/materials/course-1')).status,200);
  assert.equal((await request('/materials/course-2')).status,200);
  const library=await request('/materials').then(r=>r.text());assert.ok(library.includes('Course handbook 0'));assert.ok(library.includes('Course handbook 1'));
  const paidLibrary=await request('/materials?courseId=course-1&q=handbook').then(r=>r.text());assert.ok(paidLibrary.includes('Course handbook 0'));assert.ok(!paidLibrary.includes('Course handbook 1'));
  state.amountOverride=1; await request('/payment/callback?reference='+payment.reference); assert.equal(payment.status,'PENDING');assert.equal(state.attempts.length,0);
  state.amountOverride=null;state.verificationStatus='failed';await request('/payment/callback?reference='+payment.reference);assert.equal(payment.status,'PENDING');
  state.verificationStatus='success';
  const callback=await request('/payment/callback?reference='+payment.reference);assert.equal(callback.status,302);assert.equal(callback.headers.get('location'),path);assert.equal(payment.status,'SUCCESS');assert.equal(state.attempts.length,0);
  const cookie=callback.headers.get('set-cookie').split(';')[0];
  const access=await request(path,{headers:{cookie}}).then(r=>r.text());assert.ok(access.includes('Student details'));assert.ok(access.includes('Course handbook 0'));assert.ok(!access.includes('id="quiz-form"'));
  assert.equal((await request('/materials/download/material-0',{headers:{cookie}})).status,302);
  assert.equal((await request(path,{headers:{cookie:cookie+'tampered'}})).status,403);
  await post(path+'/start',{name:'',institution:''},cookie);assert.equal(state.attempts.length,0);
  const starts=await Promise.all([post(path+'/start',{name:'Ada Student',institution:'Academy'},cookie),post(path+'/start',{name:'Ada Student',institution:'Academy'},cookie)]);
  assert.ok((await starts[0].text()).includes('id="quiz-form"'));assert.equal(state.attempts.length,1);assert.equal(payment.candidateName,'Ada Student');
  await request('/payment/callback?reference='+payment.reference);assert.equal(state.attempts.length,1);
  // A webhook received before the browser returns also unlocks without creating an attempt.
  await post('/checkout',{courseId:'course-1',email:'second@example.com'});const second=state.payments[1];
  const payload=JSON.stringify({event:'charge.success',data:{reference:second.reference,status:'success',amount:second.amount,currency:second.currency}});
  const signature=crypto.createHmac('sha512',state.secret).update(payload).digest('hex');
  const event=()=>request('/paystack/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':signature},body:payload});
  await event();await event();assert.equal(second.status,'SUCCESS');assert.equal(second.attemptId,null);assert.equal(state.attempts.length,1);
  assert.equal((await request('/payment/callback?reference='+second.reference)).status,302);
  const adminCookie='cca_admin_auth='+adminToken;
  const denied=await post('/admin/materials/update/material-0',{title:'Changed',linkUrl:'https://example.com',courseId:'course-1'});assert.equal(denied.status,302);
  const invalid=await post('/admin/materials/update/material-0',{title:'Changed',linkUrl:'javascript:alert(1)',courseId:'course-1'},adminCookie);assert.ok((await invalid.text()).includes('valid http'));assert.equal(state.materials[0].title,'Course handbook 0');
  const saved=await post('/admin/materials/update/material-0',{title:'Updated handbook',linkUrl:'https://example.com/updated.pdf',courseId:'course-2'},adminCookie);assert.equal(saved.status,200);assert.equal(state.materials[0].courseId,'course-2');assert.equal(state.materials[0].title,'Updated handbook');assert.ok((await saved.text()).includes('Material updated.'));
  assert.ok((await request('/materials').then(r=>r.text())).includes('Updated handbook'));
  await post('/checkout',{courseId:'course-2',email:'free@example.com'});assert.equal(state.attempts.length,1);
  await post('/checkout',{courseId:'course-2',email:'free@example.com',name:'Free Student',institution:'Academy'});assert.equal(state.attempts.length,2);
  state.payments.push({...payment,id:'certificate',reference:'certificate-ref',purpose:'CERTIFICATE'});assert.ok(!(await request('/payment/callback?reference=certificate-ref')).headers.get('set-cookie'));
  assert.equal((await post('/courses/access/certificate-ref/start',{name:'A',institution:'B'},cookie)).status,403);
  console.log('PASS: free/paid separation, checkout without student details, failed/incorrect payment, signed assessment access, public materials for every course, delayed exam start, duplicate start/confirmation, webhook-first flow, material edit validation and permissions, free assessment, certificate-purpose isolation.');
 } finally {server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
