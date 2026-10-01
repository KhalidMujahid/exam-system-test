const assert = require('node:assert/strict');
const { createFixture } = require('./flow-fixture.cjs');

(async () => {
  const { app, state, adminToken } = createFixture();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, data = {}, cookie = '', origin = 'http://localhost:3000') => fetch(base + url, {
    method: 'POST', redirect: 'manual', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', cookie, ...(origin ? { origin } : {})
    }, body: new URLSearchParams(data)
  });
  try {
    for (const origin of ['https://evil.example', null, 'null']) {
      assert.equal((await post('/admin/password', { password: 'attacker-password' }, 'cca_admin_auth=' + adminToken, origin)).status, 403);
    }
    assert.equal((await post('/paystack/webhook', {}, '', null)).status, 401);
    assert.equal((await post('/attempts/unknown/submit')).status, 403);
    const start = await post('/checkout', { courseId: 'course-2', name: 'Student', institution: 'Academy', email: 'student@example.com' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const attempt = state.attempts[0];
    const url = '/attempts/' + attempt.id + '/submit';
    assert.equal((await post(url)).status, 403);
    assert.equal((await post(url, {}, cookie + 'a')).status, 403);
    const answers = Object.fromEntries(state.courses[1].questions.map(q => ['answers[' + q.id + ']', q.correctAnswer]));
    const submissions = await Promise.all([post(url, answers, cookie), post(url, {}, cookie)]);
    assert.deepEqual(submissions.map(r => r.status), [200, 200]);
    assert.equal(attempt.rawScore, 20);
    assert.match(attempt.checksum, /^CCA-SYS-TRK-[A-F0-9]{48}$/);
    // Start an already expired assessment; even correct answers must receive no credit.
    state.expired = true;
    const expiredStart = await post('/checkout', { courseId: 'course-2', name: 'Late Student', institution: 'Academy', email: 'late@example.com' });
    const expiredCookie = expiredStart.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/attempts/' + state.attempts[1].id + '/submit', answers, expiredCookie)).status, 200);
    assert.equal(state.attempts[1].rawScore, 0);
    state.materials[0].url = 'javascript:alert(1)';
    assert.equal((await fetch(base + '/materials/open/material-0', { redirect: 'manual' })).status, 400);
    for (let i = 0; i < 20; i++) await post('/admin/login', { password: 'bad' });
    const limited = await post('/admin/login', { password: 'bad' });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(limited.headers.get('x-frame-options'), 'DENY');
    console.log('PASS: CSRF, webhook authentication, attempt ownership/tampering, concurrent/repeated submission, random checksums, unsafe redirects, login throttling, security headers.');
  } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
