// Durable, host-evidence-based task graph; requires no additional model request.
// The graph records WHAT has been independently observed, not what a model says
// happened. A source edit invalidates older test/review evidence.
const KNOWN = new Set(['inspect','edit','verify','review']);
const OBJECTIVES = Object.freeze({
  inspect: 'Read relevant project instructions and the actual source.',
  edit: 'Confirm changed file bytes with a workspace SHA-256 re-read.',
  verify: 'Run appropriate real tests or checks and verify their results.',
  review: 'Inspect the actual Git diff or explicitly report the review blocker.',
});
const uniq = list => [...new Set(list)];
const clean = value => String(value??'').slice(0,300);

export function createTaskGraph(goalPlan, prior = null) {
  if(prior?.version===1 && Array.isArray(prior.nodes) &&
     prior.nodes.every(n=>KNOWN.has(n.id)))return structuredClone(prior);
  if(!goalPlan || !Array.isArray(goalPlan.phases))return null;
  const phases=goalPlan.phases.filter(x=>KNOWN.has(x.id));
  if(!phases.length)return null;
  const known=new Set(phases.map(p=>p.id));
  const nodes=phases.map((phase,i)=>({
    id:phase.id,title:clean(phase.title),
    objective:OBJECTIVES[phase.id],
    acceptanceCriteria:clean(phase.proof||OBJECTIVES[phase.id]),
    dependsOn:phase.id==='inspect'?[]:
      phase.id==='edit'?known.has('inspect')?['inspect']:[]:
      phase.id==='verify'?known.has('edit')?['edit']:known.has('inspect')?['inspect']:[]:
      uniq(['inspect',known.has('verify')?'verify':null].filter(x=>x&&known.has(x))),
    status:i===0?'working':'pending',
    receipts:[],revision:0,
  }));
  return {version:1,goal:clean(goalPlan.goal),revision:0,nodes};
}

export function advanceTaskGraph(value,evidence){
  if(!value||!KNOWN.has(evidence?.kind))return value;
  const graph=structuredClone(value);
  if(evidence.kind==='edit'){
    graph.revision++;
    // Tests run before this edit do not attest to the new source bytes.
    for(const node of graph.nodes.filter(n=>n.id==='verify'||n.id==='review')){
      node.receipts=[];node.status='pending';node.revision=graph.revision;
    }
  }
  const node=graph.nodes.find(n=>n.id===evidence.kind);
  if(node){
    const proof={kind:evidence.kind,id:clean(evidence.id??''),step:Number(evidence.step)||0,
      revision:graph.revision};
    if(!node.receipts.some(r=>r.id===proof.id&&r.step===proof.step&&r.revision===proof.revision))
      node.receipts.push(proof);
    node.receipts=node.receipts.slice(-12);
    node.revision=graph.revision;
  }
  for(const item of graph.nodes){
    const complete=item.receipts.some(r=>r.revision===graph.revision) ||
      (item.id==='inspect'&&item.receipts.length>0);
    item.status=complete?'verified':
      item.dependsOn.every(id=>graph.nodes.find(n=>n.id===id)?.status==='verified')?'working':'pending';
  }
  return graph;
}
export function taskGraphAssessment(value) {
  if(!value)return {applicable:false,verified:null,missing:[],revision:0};
  const missing=value.nodes.filter(n=>n.status!=='verified').map(n=>n.id);
  return {applicable:true,verified:missing.length===0,missing,revision:value.revision};
}
export function taskGraphInstructions(value) {
  if(!value)return '';
  return ['HOST TASK GRAPH (host-proposed plan, not proof the user request was completed):',
    ...value.nodes.map(n=>n.id+': '+n.objective+' Evidence required: '+n.acceptanceCriteria),
    'Prefer independent host evidence. After editing source, prior test results become stale.',
    'If any required objective cannot be independently checked, report the limitation truthfully. Do not loop solely to manufacture a PASS.',
  ].join('\n');
}
