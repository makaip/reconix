# Site design rules

Read this before changing the site. These rules exist because the first draft looked
machine-generated; each one removes a specific tell.

## Type
- One family: Hanken Grotesk (variable). Hierarchy comes from size, weight, and tracking,
  not from mixing faces.
- Display: weight 600, tracking -0.035em, leading 0.95. Headings: 600, tracking -0.025em.
- Sentence case everywhere. No all-caps labels, no tracked-out eyebrow text.
- No monospace in marketing copy. Monospace is only for literal code or requests.
- No small label or badge above a headline.

## Color
- Page background `#0b0b0c`, matching the 3D scene so the canvas has no seam.
- Body text `#b7b7be` (AA on the background), headings `#f2f2f3`, quiet text `#8a8a92`.
- One accent, `#4a9eff`, and only inside the 3D model (the app's own focus color).
  Severity colors appear only on the findings and approval elements in the model.
- No gradients, no colored glows, no colored card borders.

## Layout
- Copy sits in a left column; the model sits on the right. The camera moves, the layout doesn't.
- The one repeated primitive is the beat: heading, paragraph, and a short list split by hairlines.
- No cards behind copy, no frosted glass, no icon-topped feature grids, no stat rows, no numbered steps.
- Radii vary on purpose: 2px buttons, rounded model corners.

## Copy
- Specific claims that the code backs up. If the app doesn't do it, the site doesn't say it.
- Plain sentences. No em dashes. No "unleash", "supercharge", "seamless", "the future of".

## Motion
- Native scrolling only. No scroll smoothing or scroll hijacking.
- The camera eases toward each beat; focused parts of the model lift slightly so shadows read.
- No fade-in-on-scroll for text. Nothing moves that isn't explaining something.

## 3D
- Matte materials: roughness 0.9, metalness 0.
- Key light from the top left: an area light for the soft gradient plus a directional light
  for soft shadows. Low fill so the shadows still read.
- Slabs have rounded corners but only a small chamfer on the front and back edges.
- The model uses the light "clay" palette. A dark palette that follows the app's real theme is
  kept for comparison (`?palette=dark`); it was rejected because dark-on-dark hides the shadows.
- Check every beat and the transitions between them with screenshots after any camera change.
  The copy column must stay clear of the model when a beat is centered.
