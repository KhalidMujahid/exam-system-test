const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
async function main() {
  for (const file of ['views/index.ejs',...fs.readdirSync('views/partials').filter(f=>f.endsWith('.ejs')).map(f=>'views/partials/'+f)]) ejs.compile(fs.readFileSync(file,'utf8'),{filename:path.resolve(file)});
  const base='http://127.0.0.1:3108';
  for(const route of ['/','/portal','/certifications','/verify','/certificates/generate','/materials','/materials?q=missing','/materials?courseId=course-2','/materials?page=2']) {
    const res=await fetch(base+route); assert.equal(res.status,200,route); const html=await res.text(); assert.match(html,/v2.0.1/); assert.ok(!html.includes('Server error'));
  }
  const partial=await fetch(base+'/materials?q=handbook',{headers:{'HX-Request':'true'}}).then(r=>r.text()); assert.match(partial,/Course handbook 1/); assert.ok(!partial.includes('<!DOCTYPE'));
  const empty=await fetch(base+'/materials?q=missing').then(r=>r.text()); assert.match(empty,/No matching materials/);
  const session=await fetch(base+'/__test/admin-session'); const cookie=session.headers.get('set-cookie').split(';')[0];
  const admin=await fetch(base+'/admin',{headers:{cookie}}).then(r=>r.text()); assert.match(admin,/Your academy workspace/);
  const drive=await fetch(base+'/materials/download/material-1',{redirect:'manual'}); assert.equal(drive.status,302); assert.equal(drive.headers.get('location'),'https://drive.google.com/uc?export=download&id=example_file');
  const external=await fetch(base+'/materials/download/material-3',{redirect:'manual'}); assert.equal(external.headers.get('location'),'https://example.com/resource.pdf');
  assert.equal((await fetch(base+'/materials/download/missing')).status,404);
  console.log('PASS: EJS compilation, public page rendering, HTMX search, empty results, admin rendering, download redirects, missing files.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
