export function weightParts(value){
  if(value==null||value===''||!Number.isFinite(Number(value))||Number(value)<0)return null;
  const grams=Number(value),total=grams/28.349523125;
  let lb=Math.floor(total/16),oz=Number((total-lb*16).toFixed(4));
  if(oz>=16){lb++;oz=0;}
  return {grams,lb,oz:oz===0&&total-lb*16>0?'<0.0001':String(oz)};
}
