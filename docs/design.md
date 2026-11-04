# Design System Strategy: The Digital Curator (Meetup)

## 1. Overview & Creative North Star
Our North Star is a high-end editorial experience where data isn't just displayed—it is presented. We reject the "boxed-in" look of traditional SaaS dashboards. By leveraging intentional asymmetry, expansive breathing room, and a sophisticated hierarchy of surfaces, we create an environment that feels authoritative yet effortless. The aesthetic is "Soft Minimalism": a rigorous commitment to clarity where depth is communicated through tonal shifts rather than heavy lines, and importance is signaled through elite typography.

## 2. Color & Surface Architecture
The palette is rooted in a spectrum of sophisticated "cool-tinted" neutrals and a precise, professional primary accent.

### The "No-Line" Rule
To achieve a premium feel, **1px solid borders for sectioning are prohibited.** Boundaries must be defined solely through:
- **Background Color Shifts:** Placing a subtle inset section against a base canvas background.
- **Tonal Transitions:** Using padding and color to imply containment without rigid outlines.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers, like stacked sheets of fine archival paper.
- **Layer 0 (Base):** Canvas background (`#f7f9fb` or `#f9f9ff`).
- **Layer 1 (Subtle Inset):** Used for sidebars or secondary navigation.
- **Layer 2 (Floating/Cards):** The highest "perceived" lift for primary content cards (`#ffffff`).
- **Layer 3 (Interaction):** Used for hover states on list items or active navigation elements.

### The Glass & Gradient Rule
For high-impact areas (CTA buttons, hero stats, or floating modals), use a **Glassmorphism** approach. Modals or search bars allow the primary background content to bleed through slightly. Main action buttons utilize a subtle linear gradient to provide "visual soul."

## 3. Typography: The Editorial Voice
We use a dual-typeface system to balance professional rigor with modern approachability.

*   **Display & Headlines (Manrope/Space Grotesk):** Chosen for geometric precision and a modern "tech-editorial" feel.
*   **Body & Labels (Inter):** The workhorse. Used for high-legibility data density (like meeting transcripts and summaries).

**Hierarchy Note:** Use muted cool grays for subheaders and secondary text to reduce visual noise, reserving heavy contrasting text strictly for primary headers and active text.

## 4. Elevation & Depth: Tonal Layering
Traditional structural lines are replaced by the **Layering Principle**.

*   **Ambient Shadows:** For floating elements (Modals, Popovers), use heavily diffused, tinted shadows (e.g., `0 20px 40px rgba(25, 49, 93, 0.06)`). The shadow is tinted to ensure it feels like a natural part of the environment.
*   **The Ghost Border Fallback:** If a border is required for accessibility, use a "Ghost Border" (e.g., outline color at 15% opacity).
*   **Dimensionality:** Use surface highlights on the top edge of cards to mimic a light source, adding a tactile quality to the interface.

## 5. Components: Refined Primitives

### Buttons
*   **Primary:** Gradient fill, high-contrast text, fully rounded or medium border radius.
*   **Secondary/Tertiary:** Ghost style. No background, only showing background on hover to reduce visual clutter.

### Cards & Lists (The "No-Divider" Mandate)
*   Do not use line separators. Use vertical white space (`spacing-6` or `spacing-8`) to separate list items. 
*   **Card Styling:** White background, subtle corner radius (`lg` or `xl`), and a 1px "Ghost Border" at barely perceptible opacity.

### Input Fields
*   **Base:** Subdued background, no border. Focus shifts to a primary color outline or glow to indicate active state clearly without looking enclosed by default.

### Signature Components 
*   **Meeting Insights Card:** Use an asymmetric layout. Large timestamp grouped with off-set body text, creating an editorial grid.
*   **AI Pulse/Status Indicators:** A soft, breathing gradient pulse to indicate background AI processing (e.g., generating summaries) without being distracting.
