// F-088 · Pins the *Awareness* card-digest profile, which is a different artefact from
// the ERC-8350 math that anchoring-golden.test.mjs pins.
//
// ERC-8350 deliberately does not fix a memory taxonomy: "`profileId` lets applications
// define these semantics without freezing one product taxonomy into the core registry"
// (erc-8350.md §Rationale). So `_cardHash` is ours, not the standard's. The registry
// only ever sees the 32-byte deltaCommitment derived from it.
//
// That freedom ends the moment a delta is broadcast. Sepolia seq 1 for space
// 0xfdd18b37…5d5b committed a deltaCommitment computed with the profile below. Change
// any input to that digest and every already-published commitment becomes
// unreproducible — not "wrong", *unverifiable*, because the preimage that opens it no
// longer exists anywhere. The supported way to change card semantics is a NEW
// profileId (card-digest/v2), which leaves v1 deltas openable forever.
//
// Why this file exists at all, when a human reviewer already reads every diff:
//
//   The field separator is U+001F (UNIT SEPARATOR). It is non-printing. In an editor,
//   in `git diff`, in a GitHub review, and in every Read-file tool output, the source
//   `.join('\u001f')` renders as `.join('')` — visually identical to the no-separator
//   version. Git Bash's grep here is built without PCRE, so even `grep -P '\x1f'`
//   silently finds nothing. A reviewer, a formatter, or an assistant "simplifying an
//   empty string" would all produce a green diff that severs the chain.
//
//   This was not hypothetical: while auditing this very function I read the source
//   three separate ways and concluded it used no separator, and only found the byte by
//   intercepting the hash input at runtime. So the check has to be mechanical, and it
//   has to spell the separator as an escape (`'\u001f'`, visible) rather than embed the
//   literal character (invisible, and therefore self-defeating).
//
// What this pins, and what it does not:
//   - CAN: the separator codepoint, the six contributing fields and their order, the
//     absent-field coercion, and four golden digests. Source-level *and* behavioural,
//     because either alone is escapable — a source regex misses a changed hash
//     algorithm, and digests alone would not say *which* property broke.
//   - CANNOT: that Sepolia seq 1 was in fact produced by this profile. That needs the
//     private witness file plus a chain read; the CLI covers it from the other side by
//     asserting the chain-returned transitionId against the precomputed one (D7).
//   - CANNOT: stop a deliberate v2 profile. That is the supported path, and it should
//     land here as a second frozen profile beside v1, never as an edit to v1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AnchoringManager, CARD_DIGEST_PROFILE_ID, CARD_DIGEST_PROFILE_V1_ID, computeCardDigest} from '../src/daemon/anchoring/anchoring.mjs';
import {keccakUtf8} from '../src/daemon/anchoring/erc8350.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, '..', 'src', 'daemon', 'anchoring', 'anchoring.mjs');

// The frozen definition of awareness.market/profiles/memory/card-digest/v1.
const PROFILE_URL = 'https://awareness.market/profiles/memory/card-digest/v1';
const SEPARATOR = '\u001f';
const FIELDS = ['id', 'category', 'title', 'summary', 'tags', 'status'];

// Digests are over `_cardHash`, i.e. sha256(fields joined by U+001F). Regenerating
// these to make a red test pass is exactly the mistake this file exists to prevent:
// if they no longer match, the profile changed, and the question is whether that was
// intended — in which case it belongs in a v2 profile, not in new constants here.
const GOLDEN = {
  allDistinct: {
    row: {id: 'f1', category: 'f2', title: 'f3', summary: 'f4', tags: 'f5', status: 'f6'},
    digest: '2e31dba5396f2c1297743df2403334c78a28041f3b4193875450c010edbd8656',
  },
  sparse: {
    row: {id: 'only-id'},
    digest: '7a66c0672545b58c401b81ce7a706751440fb0637c76a40395d5f8c97e70e9fa',
  },
  unicode: {
    row: {
      id: 'id-1', category: 'decision', title: '标题',
      summary: 'résumé \u{1F9E0}', tags: '["a","b"]', status: 'noted',
    },
    digest: 'f93b36d3d041fc2b3b60e6b96bcd1f2318b02132dab090620148cc82f891411b',
  },
  emptyAll: {
    row: {id: '', category: '', title: '', summary: '', tags: '', status: ''},
    digest: 'de2d1aa0509a80c5446acd90700fbcd632b3bb5065b5096a7603dc7b205892da',
  },
};

// `_cardHash` reads only its argument, so a prototype-only instance is enough and
// keeps this suite free of a daemon, an indexer, and SQLite.
const hasher = Object.create(AnchoringManager.prototype);
const cardHash = (row) => computeCardDigest(row, CARD_DIGEST_PROFILE_V1_ID);

test('profileId is the frozen card-digest/v1 URL', () => {
  assert.equal(
    CARD_DIGEST_PROFILE_V1_ID, keccakUtf8(PROFILE_URL),
    'CARD_DIGEST_PROFILE_ID no longer matches ' + PROFILE_URL + '. A different URL is a ' +
    'different profile: publish it as v2 rather than repointing v1, or already-anchored ' +
    'deltas name a profile whose definition no longer exists.',
  );
});

test('source joins digest fields with U+001F, not an empty string', () => {
  const src = readFileSync(SOURCE, 'utf8');
  const body = src.match(/if \(profile === CARD_DIGEST_PROFILE_V1_ID\) \{([\s\S]*?)\} else if/);
  assert.ok(body, 'frozen v1 branch not found in ' + SOURCE + ' — this guard cannot verify anything.');

  const join = body[1].match(/\.join\((['"])([\s\S]*?)\1\)/);
  assert.ok(join, 'v1 no longer builds its basis with .join(); the guard needs updating.');

  const separator = join[2];
  assert.equal(
    separator, SEPARATOR,
    'Digest separator changed from U+001F to ' + JSON.stringify(separator) + '. If this ' +
    'looks like a no-op diff, that is the trap: U+001F is non-printing, so removing it ' +
    'renders identically. Removing it also reintroduces boundary ambiguity ' +
    '(id="ab",category="c" would collide with id="a",category="bc") and makes every ' +
    'Sepolia-anchored deltaCommitment unreproducible.',
  );
});

test('source contributes exactly the six frozen fields, in order', () => {
  const src = readFileSync(SOURCE, 'utf8');
  const body = src.match(/if \(profile === CARD_DIGEST_PROFILE_V1_ID\) \{([\s\S]*?)\} else if/);
  const basis = body[1].match(/\[([\s\S]*?)\]\.join/);
  assert.ok(basis, 'could not locate the basis array literal in the v1 helper.');

  const referenced = [...basis[1].matchAll(/row\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    referenced, FIELDS,
    'The set or order of digest fields changed. Both matter: order because the fields ' +
    'are concatenated positionally, membership because adding a field (e.g. a ' +
    'provenance or sync-envelope column) silently redefines every future content_hash. ' +
    'Additive metadata belongs in a side table — the pattern F-088 D3 already chose for ' +
    'anchor_state — or in a v2 profile.',
  );
});

test('digests match the frozen card-digest/v1 vectors', () => {
  for (const [name, {row, digest}] of Object.entries(GOLDEN)) {
    assert.equal(cardHash(row), digest, `card-digest/v1 vector "${name}" changed.`);
  }
});

test('absent fields coerce to empty string, not the literal "undefined"', () => {
  // `row.category ?? ''` is load-bearing: SQLite hands back null for unset columns, and
  // String(null) would put "null" into the preimage of every such card.
  assert.equal(
    cardHash({id: 'x'}),
    cardHash({id: 'x', category: '', title: '', summary: '', tags: '', status: ''}),
    'absent and empty fields must digest identically; the ?? \'\' coercion regressed.',
  );
  assert.notEqual(
    cardHash({id: 'x'}),
    cardHash({id: 'x', category: 'null', title: '', summary: '', tags: '', status: ''}),
    'a literal "null" string must not be indistinguishable from an absent field.',
  );
});

test('separator makes field boundaries unambiguous', () => {
  // The property the separator buys, asserted directly so that deleting it fails here
  // with a readable reason even if someone regenerates GOLDEN to match.
  assert.notEqual(
    cardHash({id: 'ab', category: 'c', title: '', summary: '', tags: '', status: ''}),
    cardHash({id: 'a', category: 'bc', title: '', summary: '', tags: '', status: ''}),
    'Two different cards produced the same digest by shifting a field boundary. The ' +
    'separator is gone or empty. Card ids are UUIDs so this is not exploitable in ' +
    'practice, but it is the signal that the preimage definition changed.',
  );
});

// Generated independently with Python json.dumps(sort_keys=True,
// ensure_ascii=False, separators=(',', ':')) + hashlib.sha256, not our helper.
const V2_GOLDEN = {
  allDistinct: 'a310a4ef890148c2a570a93eca03de30d5827c12d1de6adc040a2cfd2a0d5361',
  sparse: '4ed17fbebca3e02e5e170fbe31cb3fb9880f461c0c1a5185e50566ff175bc202',
  unicode: '9124ab702641affba1e26c6090eadabb7b93743a28ef687c2a9dcb92fcc7be14',
  emptyAll: 'd329699d0c2566929982f0ad5f111cd50ce4d57acdcc0d25610a57bebffc7d49',
};

test('v2 has a separate profile ID and independent canonical JSON vectors', () => {
  assert.equal(CARD_DIGEST_PROFILE_ID, keccakUtf8('https://awareness.market/profiles/memory/card-digest/v2'));
  assert.notEqual(CARD_DIGEST_PROFILE_ID, CARD_DIGEST_PROFILE_V1_ID);
  for (const [name, {row}] of Object.entries(GOLDEN)) {
    assert.equal(computeCardDigest(row), V2_GOLDEN[name], name);
    assert.equal(hasher._cardHash(row), V2_GOLDEN[name], 'manager uses v2: ' + name);
  }
});

test('v2 distinguishes the v1 delimiter collision and null from empty fields', () => {
  const left = {id: 'same-id', category: 'decision', title: 'A\u001fB', summary: 'C', tags: '[]', status: 'open'};
  const right = {...left, title: 'A', summary: 'B\u001fC'};
  assert.equal(cardHash(left), cardHash(right), 'v1 must remain reproducible');
  assert.notEqual(computeCardDigest(left), computeCardDigest(right));
  assert.notEqual(computeCardDigest({id: 'x'}), computeCardDigest({id: 'x', title: ''}));
  assert.equal(computeCardDigest({id: 'x', title: 'a'}), computeCardDigest({title: 'a', id: 'x'}));
});

test('unknown card digest profiles are rejected', () => {
  assert.throws(() => computeCardDigest({id: 'x'}, '0x' + '11'.repeat(32)), /unsupported/);
});
