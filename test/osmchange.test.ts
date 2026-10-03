import { describe, expect, it } from 'vitest';
import { buildOsmChange } from '../src/osm/osmchange';
import type { LiveOsmObject } from '../src/osm/osm-api';
import type { FeatureCandidate, Survey } from '../src/types';

let n = 0;
function candidate(overrides: Partial<FeatureCandidate> = {}): FeatureCandidate {
  n += 1;
  return {
    id: `cand-${n}`,
    surveyId: 's1',
    analyzer: 'openai',
    featureType: 'bench',
    lat: 35.68,
    lon: 139.76,
    positionConfidence: 0.5,
    tagConfidence: 0.5,
    tags: { amenity: 'bench' },
    observationIds: [],
    osmMatches: [],
    warnings: [],
    status: 'new',
    ...overrides
  };
}

function survey(candidates: FeatureCandidate[]): Survey {
  return {
    id: 's1',
    name: 'Test Survey',
    createdAt: 0,
    gpsSamples: [],
    photos: [],
    observations: [],
    candidates
  };
}

const liveNode = (id: number, version: number, tags: Record<string, string>): LiveOsmObject => ({
  type: 'node',
  id,
  version,
  tags
});

function liveOf(...objs: LiveOsmObject[]): Map<string, LiveOsmObject> {
  const m = new Map<string, LiveOsmObject>();
  for (const o of objs) m.set(`${o.type}/${o.id}`, o);
  return m;
}

describe('buildOsmChange', () => {
  it('blocks fabricated and unverified candidates from XML', () => {
    const mock = candidate({ analyzer: 'mock' });
    const legacy = candidate({ analyzer: undefined, status: 'existing', linkedOsmId: 42 });
    const res = buildOsmChange(survey([mock, legacy]), liveOf(liveNode(42, 1, {})));
    expect(res.xml).toBe('');
    expect(res.creates).toBe(0);
    expect(res.modifies).toBe(0);
  });
  it('emits <create> for new candidates with position', () => {
    const res = buildOsmChange(survey([candidate(), candidate({ lat: 1, lon: 2 })]), liveOf());
    expect(res.creates).toBe(2);
    expect(res.xml).toContain('<create>');
    expect(res.xml).toContain('<node id="-1" lat="35.6800000" lon="139.7600000">');
    expect(res.xml).toContain('<tag k="amenity" v="bench"/>');
    expect(res.xml).toContain('</create>');
    // No modify section when nothing is modified.
    expect(res.xml).not.toContain('<modify>');
  });

  it('escapes tag keys/values', () => {
    // Issue #11: the candidate also carries its required class tags —
    // a name-only tag set is not a semantic classification and is blocked.
    const res = buildOsmChange(
      survey([candidate({ tags: { amenity: 'bench', name: 'A&B <x>' } })]),
      liveOf()
    );
    expect(res.xml).toContain('<tag k="name" v="A&amp;B &lt;x&gt;"/>');
  });

  it('adds the name tag when set but absent from tags', () => {
    const res = buildOsmChange(survey([candidate({ name: 'Park Bench' })]), liveOf());
    expect(res.xml).toContain('<tag k="name" v="Park Bench"/>');
  });

  it('emits <modify> with the CURRENT version and merged tags for node modifications', () => {
    const c = candidate({
      status: 'existing',
      linkedOsmId: 12345,
      linkedOsmType: 'node',
      tags: { name: 'Renamed Bench' }
    });
    const res = buildOsmChange(
      survey([c]),
      liveOf(liveNode(12345, 7, { amenity: 'bench', name: 'Old Name' }))
    );
    expect(res.modifies).toBe(1);
    expect(res.xml).toContain('<modify>');
    // Current version, not the stale snapshot.
    expect(res.xml).toContain('<node id="12345" version="7"');
    // Candidate tags override live tags; unrelated live tags are kept.
    expect(res.xml).toContain('<tag k="amenity" v="bench"/>');
    expect(res.xml).toContain('<tag k="name" v="Renamed Bench"/>');
    expect(res.xml).not.toContain('Old Name');
    // Dragged position is carried.
    expect(res.xml).toContain('lat="35.6800000"');
  });

  it('reports a conflict and excludes a modify whose live object is unavailable', () => {
    const c = candidate({ status: 'existing', linkedOsmId: 999, linkedOsmType: 'node' });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.modifies).toBe(0);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].osmId).toBe(999);
    expect(res.xml).toBe('');
  });

  it('blocks way/relation modifications and reports them', () => {
    const wayCand = candidate({
      status: 'existing',
      linkedOsmId: 555,
      linkedOsmType: 'way',
      tags: { highway: 'footway' }
    });
    const res = buildOsmChange(survey([wayCand]), liveOf(liveNode(12345, 7, {})));
    expect(res.modifies).toBe(0);
    expect(res.blocked).toEqual([
      { candidateId: expect.any(String), osmType: 'way', osmId: 555 }
    ]);
    expect(res.xml).toBe('');
  });

  it('defaults a missing linkedOsmType to node (legacy rows)', () => {
    const c = candidate({ status: 'existing', linkedOsmId: 12345, tags: { name: 'X' } });
    const res = buildOsmChange(
      survey([c]),
      liveOf(liveNode(12345, 3, { ref: 'A1' }))
    );
    expect(res.modifies).toBe(1);
    expect(res.xml).toContain('<node id="12345" version="3"');
    expect(res.xml).toContain('<tag k="ref" v="A1"/>');
    expect(res.xml).toContain('<tag k="name" v="X"/>');
  });

  it('never emits non-standard constructs (add / creadetag / delete)', () => {
    const res = buildOsmChange(
      survey([
        candidate(),
        candidate({ status: 'existing', linkedOsmId: 1, linkedOsmType: 'node' }),
        candidate({ status: 'existing', linkedOsmId: 2, linkedOsmType: 'way' })
      ]),
      liveOf(liveNode(1, 1, { a: 'b' }))
    );
    expect(res.xml).not.toContain('<add>');
    expect(res.xml).not.toContain('</add>');
    expect(res.xml).not.toContain('creadetag');
    expect(res.xml).not.toContain('<delete>');
    expect(res.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<osmChange>')).toBe(true);
    expect(res.xml.trimEnd().endsWith('</osmChange>')).toBe(true);
  });

  it('returns an empty xml when there is nothing to export', () => {
    const res = buildOsmChange(
      survey([
        candidate({ status: 'excluded' }),
        candidate({ lat: undefined, lon: undefined })
      ]),
      liveOf()
    );
    expect(res.xml).toBe('');
    expect(res.creates).toBe(0);
    expect(res.modifies).toBe(0);
  });
});

describe('geometry policy (issue #9): no polygon fabrication', () => {
  it('does not create area-based candidates; reports them in geometryBlocked', () => {
    const c = candidate({ featureType: 'playground_area', tags: { leisure: 'playground' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(0);
    expect(res.geometryBlocked).toHaveLength(1);
    expect(res.geometryBlocked[0].candidateId).toBe(c.id);
    expect(res.geometryBlocked[0].featureType).toBe('playground_area');
    expect(res.geometryBlocked[0].reason).toContain('does not fabricate');
    expect(res.xml).toBe('');
  });

  it('still creates node/either-based candidates', () => {
    const c = candidate({ featureType: 'bollard', tags: { barrier: 'bollard' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.geometryBlocked).toEqual([]);
    expect(res.xml).toContain('<create>');
    expect(res.xml).toContain('<tag k="barrier" v="bollard"/>');
  });

  it('mixes: node class created, area class blocked', () => {
    const benchC = candidate();
    const areaC = candidate({ featureType: 'playground_area', tags: { leisure: 'playground' } });
    const res = buildOsmChange(survey([benchC, areaC]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.geometryBlocked).toHaveLength(1);
    expect(res.xml).toContain('<tag k="amenity" v="bench"/>');
    expect(res.xml).not.toContain('leisure');
    expect(res.xml).not.toContain('playground');
  });

  it('does not block existing-object modifications for area classes', () => {
    const c = candidate({
      featureType: 'playground_area',
      status: 'existing',
      linkedOsmId: 2001,
      linkedOsmType: 'node',
      tags: { name: 'Town Playground' }
    });
    const res = buildOsmChange(
      survey([c]),
      liveOf(liveNode(2001, 2, { leisure: 'playground' }))
    );
    expect(res.modifies).toBe(1);
    expect(res.geometryBlocked).toEqual([]);
    expect(res.xml).toContain('<node id="2001" version="2"');
    expect(res.xml).toContain('<tag k="leisure" v="playground"/>');
  });

  it('treats unknown feature types as node-based (creates allowed)', () => {
    const c = candidate({ featureType: 'mystery', tags: { random: 'tag' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.geometryBlocked).toEqual([]);
    expect(res.semanticsBlocked).toEqual([]);
  });
});

describe('semantic gate (issue #11): no untagged creates', () => {
  it('creates a new bench with its required amenity=bench tag', () => {
    const res = buildOsmChange(survey([candidate()]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.semanticsBlocked).toEqual([]);
    expect(res.geometryBlocked).toEqual([]);
  });

  it('blocks a generic playground without playground=* and reports it in semanticsBlocked', () => {
    const c = candidate({ featureType: 'playground', tags: {} });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(0);
    expect(res.semanticsBlocked).toHaveLength(1);
    expect(res.semanticsBlocked[0].candidateId).toBe(c.id);
    expect(res.semanticsBlocked[0].featureType).toBe('playground');
    expect(res.semanticsBlocked[0].reason).toContain('playground=*');
    expect(res.geometryBlocked).toEqual([]);
    expect(res.xml).toBe('');
  });

  it('creates the playground after playground=slide is selected', () => {
    const c = candidate({ featureType: 'playground', tags: { playground: 'slide' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.semanticsBlocked).toEqual([]);
    expect(res.xml).toContain('<tag k="playground" v="slide"/>');
  });

  it('blocks a review-only statue with no mapping/tags', () => {
    const c = candidate({ featureType: 'statue', tags: {} });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(0);
    expect(res.semanticsBlocked[0].featureType).toBe('statue');
    expect(res.semanticsBlocked[0].reason).toContain('mapping');
    expect(res.xml).toBe('');
  });

  it('creates the statue after an artwork mapping is chosen', () => {
    const c = candidate({
      featureType: 'statue',
      tags: { tourism: 'artwork', artwork_type: 'statue' }
    });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.semanticsBlocked).toEqual([]);
    expect(res.xml).toContain('<tag k="tourism" v="artwork"/>');
  });

  it('creates a stone lantern with manually entered meaningful semantic tags', () => {
    const c = candidate({ featureType: 'stone_lantern', tags: { historic: 'stone_lantern' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(1);
    expect(res.semanticsBlocked).toEqual([]);
  });

  it('still blocks name=* alone (no semantic classification)', () => {
    const c = candidate({ featureType: 'stone_lantern', tags: { name: 'Foo' } });
    const res = buildOsmChange(survey([c]), liveOf());
    expect(res.creates).toBe(0);
    expect(res.semanticsBlocked).toHaveLength(1);
    expect(res.xml).toBe('');
  });

  it('keeps geometry-blocked and semantics-blocked reasons distinguishable', () => {
    const areaC = candidate({ featureType: 'playground_area', tags: { leisure: 'playground' } });
    const genericC = candidate({ featureType: 'playground', tags: {} });
    const res = buildOsmChange(survey([areaC, genericC]), liveOf());
    expect(res.creates).toBe(0);
    expect(res.geometryBlocked).toHaveLength(1);
    expect(res.geometryBlocked[0].candidateId).toBe(areaC.id);
    expect(res.geometryBlocked[0].reason).toContain('does not fabricate');
    expect(res.semanticsBlocked).toHaveLength(1);
    expect(res.semanticsBlocked[0].candidateId).toBe(genericC.id);
    expect(res.semanticsBlocked[0].reason).toContain('playground=*');
    expect(res.geometryBlocked[0].reason).not.toBe(res.semanticsBlocked[0].reason);
    expect(res.xml).toBe('');
  });

  it('does not affect existing-object modify behavior', () => {
    // A review-only class linked to an existing tagged object is still
    // modified: the semantic gate applies to NEW objects only.
    const c = candidate({
      featureType: 'statue',
      status: 'existing',
      linkedOsmId: 777,
      linkedOsmType: 'node',
      tags: { name: 'Statue of the Founder' }
    });
    const res = buildOsmChange(
      survey([c]),
      liveOf(liveNode(777, 4, { historic: 'memorial' }))
    );
    expect(res.modifies).toBe(1);
    expect(res.semanticsBlocked).toEqual([]);
    expect(res.xml).toContain('<node id="777" version="4"');
    expect(res.xml).toContain('<tag k="historic" v="memorial"/>');
    expect(res.xml).toContain('<tag k="name" v="Statue of the Founder"/>');
  });
});
