import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleProfileOverrides } from '../src/lib/model-profile-selection.ts';

const profiles=[{id:'review-profile'},{id:'test-profile'},{id:'coding'}];
test('role model overrides preserve explicit valid task routes',()=>{
  assert.deepEqual(parseRoleProfileOverrides('',profiles),{});
  assert.deepEqual(parseRoleProfileOverrides('{"Reviewer":"review-profile","Independent verifier":"test-profile"}',profiles),
    {reviewer:'review-profile',independent_verifier:'test-profile'});
});
test('role model overrides reject unknown profiles, invalid role names and prototype pollution',()=>{
  for(const bad of [
    '{"reviewer":"deleted"}', '{"__proto__":"coding"}',
    '{"reviewer":"coding","Reviewer":"review-profile"}',
    '{"bad/role":"coding"}','["coding"]',
    '{"reviewer":5}','{"reviewer":"coding"} garbage',
    JSON.stringify(Object.fromEntries(Array.from({length:13},(_,i)=>['role'+i,'coding']))),
  ])assert.throws(()=>parseRoleProfileOverrides(bad,profiles));
});
