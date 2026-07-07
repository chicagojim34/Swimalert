/**
 * Seed a running Swimalert server with a demo meet.
 * Usage: npm run seed [-- http://localhost:4000]
 */
const base = process.argv[2] ?? 'http://localhost:4000';

const names = [
  ['Emma R', 'DOLPHINS'], ['Liam T', 'DOLPHINS'], ['Ava M', 'SHARKS'], ['Noah P', 'SHARKS'],
  ['Mia K', 'WAVES'], ['Lucas B', 'WAVES'], ['Zoe C', 'DOLPHINS'], ['Owen D', 'SHARKS'],
  ['Lily F', 'WAVES'], ['Jack G', 'DOLPHINS'], ['Nora H', 'SHARKS'], ['Eli J', 'WAVES'],
] as const;

function heatEntries(offset: number, count = 6) {
  return Array.from({ length: count }, (_, i) => {
    const [name, team] = names[(offset + i) % names.length];
    return { swimmer: { name, team }, lane: i + 1 };
  });
}

const program = {
  name: 'Summer Classic (demo)',
  date: new Date().toISOString().slice(0, 10),
  laneCount: 6,
  events: [
    { number: 1, name: 'Girls 50 Free', heats: [1, 2].map((n) => ({ number: n, entries: heatEntries(n) })) },
    { number: 2, name: 'Boys 50 Free', heats: [1, 2].map((n) => ({ number: n, entries: heatEntries(n + 3) })) },
    { number: 3, name: 'Girls 100 Back', heats: [1].map((n) => ({ number: n, entries: heatEntries(n + 7) })) },
    { number: 4, name: 'Boys 100 Back', heats: [1].map((n) => ({ number: n, entries: heatEntries(n + 9) })) },
  ],
};

const res = await fetch(`${base}/meets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(program),
});
const meet = await res.json();
if (!res.ok) {
  console.error('Seed failed:', meet);
  process.exit(1);
}
console.log(`Seeded meet "${meet.name}" (${meet.id})`);
console.log(`Advance heats with: curl -X POST ${base}/meets/${meet.id}/advance`);
