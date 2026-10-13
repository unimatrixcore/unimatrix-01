const test=require('node:test'),assert=require('node:assert/strict');
const {isEligible,filterPayload,todayInPhoenix}=require('./released-only.cjs');
const today='2026-10-11';
const movie=(type,date,region='US')=>({release_dates:{results:[{iso_3166_1:region,release_dates:[{type,release_date:date}]}]}});
test('theatrical and physical releases do not qualify as digital',()=>{assert.equal(isEligible(movie(3,'2026-07-17'),'movie','US',today),false);assert.equal(isEligible(movie(5,'2025-01-01'),'movie','US',today),false)});
test('digital future stays hidden; release today and past qualify',()=>{assert.equal(isEligible(movie(4,'2026-11-17'),'movie','US',today),false);assert.equal(isEligible(movie(4,today),'movie','US',today),true);assert.equal(isEligible(movie(4,'2020-01-01'),'movie','US',today),true)});
test('regional dates are respected',()=>assert.equal(isEligible(movie(4,'2020-01-01','GB'),'movie','US',today),false));
test('missing and malformed digital dates fail closed',()=>{assert.equal(isEligible({},'movie','US',today),false);assert.equal(isEligible(movie(4,'not-a-date'),'movie','US',today),false);assert.equal(isEligible(movie(4,'2025-02-31'),'movie','US',today),false)});
const tv={first_air_date:'2021-04-30',status:'Returning Series','watch/providers':{results:{US:{flatrate:[{provider_id:283}]}}}};
test('aired series with streaming provider qualify',()=>assert.equal(isEligible(tv,'tv','US',today),true));
test('unaired, planned, unavailable series do not qualify',()=>{assert.equal(isEligible({...tv,first_air_date:'2027-01-01'},'tv','US',today),false);assert.equal(isEligible({...tv,status:'Planned'},'tv','US',today),false);assert.equal(isEligible({...tv,'watch/providers':{results:{}}},'tv','US',today),false)});
test('mapped Seerr release and provider data also qualify',()=>{assert.equal(isEligible({releases:movie(4,'2025-01-01').release_dates},'movie','US',today),true);assert.equal(isEligible({firstAirDate:'2021-04-30',watchProviders:[{iso_3166_1:'US',buy:[{id:1}]}]},'tv','US',today),true)});
test('nested known-for and collection/credit lists are filtered while people remain',async()=>{const data={results:[{id:1,mediaType:'movie'},{id:2,mediaType:'person',knownFor:[{id:3,mediaType:'tv'},{id:4,mediaType:'movie'}]}],parts:[{id:5,title:'Future'}],cast:[{id:6,name:'Actor'}]};const result=await filterPayload(data,async x=>x.id===1||x.id===3);assert.deepEqual(result.results.map(x=>x.id),[1,2]);assert.deepEqual(result.results[1].knownFor.map(x=>x.id),[3]);assert.deepEqual(result.parts,[]);assert.equal(result.cast[0].id,6);assert.equal(data.parts.length,1)});
test('day follows Phoenix rather than host UTC',()=>assert.equal(todayInPhoenix(new Date('2026-10-12T03:00:00Z')),today));

test('digital proof wins even if the primary theatrical date is future',()=>assert.equal(isEligible({...movie(4,'2025-01-01'),releaseDate:'2027-01-01'},'movie','US',today),true));
