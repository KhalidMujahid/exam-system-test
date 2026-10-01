// Local test server only. No live database or payment credentials.
const {createFixture}=require('./flow-fixture.cjs');
const {app,adminToken,state}=createFixture();
app.get('/__test/admin-session', (req,res)=>{res.cookie('cca_admin_auth',adminToken,{httpOnly:true,sameSite:'lax'});res.send('Test session ready');});
app.get('/__test/latest-payment', (req,res)=>res.json({reference:state.payments.at(-1)?.reference}));
app.listen(3108,'127.0.0.1',()=>console.log('Isolated design preview: http://127.0.0.1:3108'));
