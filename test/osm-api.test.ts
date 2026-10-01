import { describe, expect, it } from 'vitest';
import { parseOsmObject } from '../src/osm/osm-api';

const nodeXml = `<osm>
  <node id="12345" version="7" changeset="999" timestamp="2026-07-10T09:00:00Z" lat="35.6812345" lon="139.7654321">
    <tag k="amenity" v="bench"/>
    <tag k="name" v="Riverside &amp; Bench"/>
  </node>
</osm>`;

const wayXml = `<osm>
  <way id="777" version="2" changeset="999" timestamp="2026-07-10T09:00:00Z">
    <nd ref="1"/>
    <nd ref="2"/>
    <tag k="highway" v="footway"/>
  </way>
</osm>`;

describe('parseOsmObject', () => {
  it('parses node id, version, position and tags', () => {
    const obj = parseOsmObject('node', nodeXml);
    expect(obj.type).toBe('node');
    expect(obj.id).toBe(12345);
    expect(obj.version).toBe(7);
    expect(obj.lat).toBeCloseTo(35.6812345);
    expect(obj.lon).toBeCloseTo(139.7654321);
    expect(obj.tags).toEqual({
      amenity: 'bench',
      name: 'Riverside & Bench'
    });
  });

  it('parses way/relation header attributes without a position', () => {
    const obj = parseOsmObject('way', wayXml);
    expect(obj.type).toBe('way');
    expect(obj.id).toBe(777);
    expect(obj.version).toBe(2);
    expect(obj.tags).toEqual({ highway: 'footway' });
    expect(obj.lat).toBeUndefined();
    expect(obj.lon).toBeUndefined();
  });

  it('handles entities in tag values (ampersand, quotes, angle brackets)', () => {
    const xml = `<node id="1" version="1" changeset="1" timestamp="t" lat="0" lon="0"><tag k="name" v="A &quot;B&quot; &lt;C&gt;"/></node>`;
    expect(parseOsmObject('node', xml).tags.name).toBe('A "B" <C>');
  });

  it('throws on unrecognized XML', () => {
    expect(() => parseOsmObject('node', '<nonsense/>')).toThrow();
    expect(() => parseOsmObject('way', '<node id="1"/>')).toThrow();
  });
});
