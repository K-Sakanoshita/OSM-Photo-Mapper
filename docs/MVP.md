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
- heading when available

### 2. Capture photos

The user walks normally and takes photos without stopping to tag each object.

For each photo, store:

- image
- capture timestamp
- nearest GPS samples
- GPS accuracy
- heading / orientation when available
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

Before upload, show a complete summary of the proposed OSM changes.

The user must explicitly approve the changeset.

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
