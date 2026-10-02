# MVP Specification

## Goal

Validate whether a mobile web app can turn a walking photo survey into reviewable OpenStreetMap edit candidates.

The MVP is not an autonomous mapper. It creates candidates that a mapper must review before upload.

## User flow

### 1. Start survey

The user starts a survey session.

The application requests the permissions it needs and begins recording:

- latitude / longitude
- reported GPS accuracy
- timestamp
- movement track
- movement heading (direction of travel) when available

### 2. Capture photos

The user walks normally and takes photos without stopping to tag each object.

For each photo, store:

- image
- capture timestamp
- nearest GPS samples
- GPS accuracy
- camera bearing (device orientation, with freshness + provenance) when available
- movement heading (direction of travel) when available
- survey session ID

### 3. Map photos

The user presses **Map photos** after collecting a set of images.

The application processes the batch and generates feature candidates.

Analysis should include:

- visually identifiable feature type
- suggested OSM tags
- text visible in the photo when useful
- estimated object direction and distance
- grouping of the same object across multiple photos
- search for nearby existing OSM features

### 4. Estimate feature positions

Position estimation should combine multiple signals rather than treating the camera location as the mapped feature location.

Candidate inputs include:

1. photo capture GPS position
2. GPS accuracy
3. camera / device heading
4. estimated distance to the detected object
5. observations of the same object from other positions
6. nearby OSM objects
7. geographic constraints appropriate to the feature type

The output is an estimated coordinate plus confidence / review information.

### 5. Review candidates

Display all candidates in two synchronized views:

- map
- list

A candidate should expose:

- source photo(s)
- detected feature type
- suggested coordinate
- suggested tags
- possible existing OSM object
- confidence / warning state

The mapper can:

- drag the pin
- edit or remove tags
- enter or correct names
- associate with an existing OSM object
- mark the candidate as new
- exclude a false positive

### 6. Review upload

Before export, show a complete summary of the proposed OSM changes:

- new nodes to create (with final tags and coordinates)
- existing nodes to modify (linked by OSM type + ID)
- modifications that are blocked (way/relation links — see below)
- excluded candidates and candidates missing a position

The user must explicitly approve the export.

#### Output contract: editor-import only (experimental)

The MVP does **not** upload to OpenStreetMap itself. On approval it emits a
standard osmChange file (only the standard `create` / `modify` constructs —
never custom or non-standard syntax) that the mapper imports into an OSM
editor (iD, JOSM, ...) after a final visual check. The editor creates the
changeset at import time; the app supplies a suggested changeset comment but
changeset comments are not embedded in the osmChange file. Direct API upload
(OAuth) is future work, not part of the MVP.

#### Modification safety rules

- A modification is only exported with the object's **current** state, fetched
  from the public OSM API immediately before export. The exported `modify`
  carries the current object version, and the merged tag set is built from the
  current tags overlaid with the reviewed candidate tags (candidate wins on
  conflicts). A stale snapshot from the analysis-time nearby lookup is never
  used for export.
- If the live object cannot be fetched (network error, 404, ...), the
  modification is **excluded** and reported as an explicit conflict — never
  silently dropped.
- Only **node** modifications are exported. Modifying a way would require its
  full node reference list and current structure, which the MVP does not
  fetch; way/relation links are therefore blocked for export and reported on
  the review screen. They may still serve as duplicate/existing references.

#### Linked object identity

A candidate linked to an existing OSM object stores both the object's type
(`node` / `way` / `relation`) and its ID. Legacy rows that only stored the ID
have their type resolved from the stored nearby-match list at load time
(falling back to `node`).

## Initial feature classes

Good MVP candidates are visually identifiable and usually representable as nodes:

- `amenity=bench`
- `amenity=vending_machine`
- `playground=*`
- information boards / maps
- `amenity=drinking_water`
- `amenity=toilets`
- AEDs
- bicycle parking
- waste baskets

The exact tag presets should be based on current OSM tagging conventions rather than hard-coded assumptions scattered through the UI.

## Out of scope for the MVP

- direct OSM API uploads (OAuth); the MVP emits editor-import files only
- way/relation modifications (node-only export; see §6)
- autonomous OSM uploads
- automatic mapping of complex polygons
- route relations
- administrative boundaries
- road network topology editing
- automatic acceptance of names inferred from photographs
- automatic modification of an existing OSM object without user review

## Important data-model distinction

Do not model the system as `Photo -> Pin`.

Instead:

```text
Survey
  -> Photos
  -> Observations
  -> Feature candidates
  -> OSM edit candidates
```

A photo may contain several observations, and several photos may describe the same real-world feature.
