import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { firstName, getDisplayName, initialOf, markNamePrompted, normalizeDisplayName, resolveDisplayName, setDisplayName, shouldPromptForName } from '../profileService.ts';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`✓ ${name}`); }

async function main() {
  await test('validation: trimmed, 1-40 characters', () => {
    assert.equal(normalizeDisplayName('  Suyog  '), 'Suyog');
    assert.equal(normalizeDisplayName('   '), null);
    assert.equal(normalizeDisplayName(''), null);
    assert.equal(normalizeDisplayName('a'.repeat(40)), 'a'.repeat(40));
    assert.equal(normalizeDisplayName('a'.repeat(41)), null);
    assert.equal(normalizeDisplayName('A   B'), 'A B');
  });
  await test('save and read back; invalid names store nothing; saving again replaces', async () => {
    const db = new NodeSqliteAdapter(':memory:');
    await runMigrations(db);
    assert.equal(await getDisplayName(db), null);
    assert.equal(await setDisplayName(db, '   '), false);
    assert.equal(await getDisplayName(db), null);
    assert.equal(await setDisplayName(db, ' Asha '), true);
    assert.equal(await getDisplayName(db), 'Asha');
    assert.equal(await setDisplayName(db, 'Ravi'), true);
    assert.equal(await getDisplayName(db), 'Ravi');
  });
  await test('migrations are repeatable on an existing install and keep the name', async () => {
    const db = new NodeSqliteAdapter(':memory:');
    await runMigrations(db);
    await setDisplayName(db, 'Asha');
    await runMigrations(db);
    assert.equal(await getDisplayName(db), 'Asha');
  });
  await test('one-time prompt: only without a name, and never again once offered', async () => {
    const db = new NodeSqliteAdapter(':memory:');
    await runMigrations(db);
    assert.equal(await shouldPromptForName(db), true);
    await markNamePrompted(db);
    assert.equal(await shouldPromptForName(db), false);
    const db2 = new NodeSqliteAdapter(':memory:');
    await runMigrations(db2);
    await setDisplayName(db2, 'Asha');
    assert.equal(await shouldPromptForName(db2), false);
  });
  await test('which name is shown', () => {
    assert.equal(resolveDisplayName('Asha', 'Account Name'), 'Asha');
    assert.equal(resolveDisplayName(null, 'Account Name'), 'Account Name');
    assert.equal(resolveDisplayName(null, ''), null);
    assert.equal(resolveDisplayName(null, '   '), null, 'blank account name: no name, never an empty line');
    assert.equal(resolveDisplayName(null, undefined), null);
    assert.equal(resolveDisplayName(null, 'A'.repeat(60)), 'A'.repeat(40), 'a long account name is shortened, not dropped'); 
    assert.equal(firstName('Asha Rao'), 'Asha');
    assert.equal(firstName(null), null);
    assert.equal(initialOf('asha'), 'A');
    assert.equal(initialOf(null), '•');
  });
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
