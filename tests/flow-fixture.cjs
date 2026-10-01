const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');

function createFixture() {
  const courses = [
    { id: 'course-1', code: 'CCA-01', name: 'Introduction to Cyber Crime Investigation', requiresPayment: true, priceKobo: 2000000, certificatePriceKobo: 500000 },
    { id: 'course-2', code: 'CCA-02', name: 'Digital Forensics and Evidence Preservation', requiresPayment: false, priceKobo: 0, certificatePriceKobo: 0 }
  ];
  courses.forEach(c => {
    c.questions = Array.from({ length: 22 }, (_, i) => ({ id: c.id + '-q' + i, questionId: c.code + '-Q' + i, text: 'Sample question ' + (i+1), optionA:'First answer', optionB:'Second answer', optionC:'Third answer', optionD:'Fourth answer', correctAnswer:'First answer' }));
    c._count = { questions: c.questions.length };
  });
  const materials = Array.from({length: 52}, (_, i) => ({ id:'material-'+i, title:i<2?'Course handbook '+i:'Learning resource '+i, url:i<2?'https://drive.google.com/file/d/example_file/view':'https://example.com/resource.pdf', courseId:courses[i%2].id, createdAt:new Date('2026-09-20') }));
  const payments = [], attempts = [], links = [];
  const withCourse = p => p && ({...p,course:course(p.courseId)});
  const course = id => { const c = courses.find(c=>c.id===id); return c && {...c,materials:materials.filter(m=>m.courseId===id)}; };
  function filtered(where={}) {
    return materials.filter(m=> (!where.courseId || m.courseId===where.courseId) && (!where.course || course(m.courseId).requiresPayment === where.course.requiresPayment) && (!where.OR || [m.title,course(m.courseId).name,course(m.courseId).code].some(s=>s.toLowerCase().includes(where.OR[0].title.contains.toLowerCase()))));
  }
  let lock=Promise.resolve();
  const prisma = {
    $connect:async()=>{},
    $queryRaw:async()=>[],
    $executeRaw:async()=>1,
    $transaction:fn=> { const task=lock.then(()=>fn(prisma)); lock=task.catch(()=>{}); return task; },
    course:{findMany:async({where}={})=>courses.filter(c=>!where || c.requiresPayment===where.requiresPayment).map(c=>course(c.id)),findUnique:async({where})=>course(where.id)},
    setting:{findUnique:async({where})=>({value:where.key==='examDurationMinutes'?'30':'128'})},
    courseMaterial:{findMany:async({where,skip=0,take=999})=>filtered(where).slice(skip,skip+take).map(m=>({...m,course:course(m.courseId)})),count:async({where})=>filtered(where).length,findUnique:async({where})=>{const m=materials.find(m=>m.id===where.id);return m&&{...m,course:course(m.courseId)};},update:async({where,data})=>Object.assign(materials.find(m=>m.id===where.id),data)},
    payment:{create:async({data})=>{const p={id:'payment-'+payments.length,purpose:'ASSESSMENT',attemptId:null,...data};payments.push(p);return withCourse(p);},findUnique:async({where})=>withCourse(payments.find(p=>where.reference?p.reference===where.reference:p.id===where.id)),update:async({where,data})=>Object.assign(payments.find(p=>p.id===where.id),data),updateMany:async({where,data})=>{const p=payments.find(p=>p.id===where.id);if(p&&p.status!=='SUCCESS')Object.assign(p,data);return {count:1};}},
    attempt:{create:async({data})=>{const a={id:'attempt-'+attempts.length,...data,...(state.expired ? {startedAt:new Date(Date.now()-3600000)} : {})};attempts.push(a);return a;},findUnique:async({where})=>{const a=attempts.find(a=>a.id===where.id);return a&&{...a,course:course(a.courseId),questionLinks:links.filter(l=>l.attemptId===a.id).map(l=>({...l,question:courses.flatMap(c=>c.questions).find(q=>q.id===l.questionId)}))};},update:async({where,data})=>{const a=attempts.find(a=>a.id===where.id);Object.assign(a,data);return {...a,course:course(a.courseId)};}},
    attemptQuestion:{createMany:async({data})=>links.push(...data),findMany:async({where})=>links.filter(l=>l.attemptId===where.attemptId).map(l=>({...l,question:courses.flatMap(c=>c.questions).find(q=>q.id===l.questionId)}))}
  };
  const state={courses,materials,payments,attempts,verificationStatus:'success',amountOverride:null,secret:'isolated-test-secret'};
  const fakeFetch=async(url,options)=>({ok:true,json:async()=>{
    if(url.endsWith('/initialize')){const body=JSON.parse(options.body);return {status:true,data:{authorization_url:'https://checkout.paystack.com/test',access_code:'access-test',reference:body.reference}};}
    const reference=decodeURIComponent(url.split('/').pop());const p=payments.find(p=>p.reference===reference);
    return {status:true,data:{reference,status:state.verificationStatus,amount:state.amountOverride??p.amount,currency:p.currency}};
  }});
  const customRequire=id=>id==='@prisma/client'?{PrismaClient:function(){return prisma;}}:id==='dotenv'?{config(){}}:require(id);
  customRequire.resolve=require.resolve;
  const source=fs.readFileSync(path.join(root,'server.js'),'utf8').replace(/main\(\)\.catch\([\s\S]*$/,'globalThis.previewApp=app;');
  const context={require:customRequire,__dirname:root,console,process:{env:{PAYSTACK_SECRET_KEY:state.secret,APP_BASE_URL:'http://localhost:3000'}},Buffer,fetch:fakeFetch,URL};
  vm.runInNewContext(source,context);
  return {app:context.previewApp,state,adminToken:context.createAdminSession()};
}
module.exports={createFixture};
