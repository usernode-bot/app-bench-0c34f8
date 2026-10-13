// Tailwind config for this app's precompiled stylesheet.
//
// npm run build (Docker or Paketo) runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm ci --include=dev
//   npm run build

// A colour token: a CSS variable holding "R G B", set for the light and the
// dark look in styles/tailwind-input.css. <alpha-value> keeps opacity
// modifiers working (bg-accent/10).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically go here, since the extractor
  // cannot see them. Prefer whole literals in the markup instead. app.js
  // picks a chip's colour class from the feed's colour number
  // ("feed-" + color), and Tailwind prunes unused @layer components rules,
  // so the six hand-written .feed-N rules in styles/tailwind-input.css
  // need their names here to survive the build.
  safelist: ['feed-1', 'feed-2', 'feed-3', 'feed-4', 'feed-5', 'feed-6'],

  // dark: variants key off a "dark" class on <html>, which public/index.html
  // sets from the viewer's Homeroom theme (the platform bridge reports it),
  // rather than off the OS colour-scheme preference: inside the platform's
  // frame that media query sees only the operating system.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  // This app's design kit, added to Tailwind's defaults: the stock palettes
  // and sizes still exist, but the screen uses these names. The colours are
  // semantic, so each is right in both looks with no dark: variant. To
  // re-theme the app, change the token VALUES in styles/tailwind-input.css
  // and keep these names.
  theme: {
    extend: {
      colors: {
        ground: token('ground'), // the page
        surface: token('surface'), // lists, cards, fields
        raised: token('raised'), // hovers, badges
        fg: token('fg'), // text
        muted: token('muted'), // secondary text
        line: token('line'), // borders, dividers, skeletons
        accent: token('accent'), // the one accent: the primary action
        'on-accent': token('on-accent'), // text on the accent
        danger: token('danger'),
        'on-danger': token('on-danger'),
        focus: token('focus'), // the keyboard focus ring
        // The six feed-chip colours and their text. A chip's class is picked
        // from the feed's colour number in app.js ("feed-" + color), so the
        // six names are on the safelist above.
        'feed-1': token('feed-1'),
        'feed-2': token('feed-2'),
        'feed-3': token('feed-3'),
        'feed-4': token('feed-4'),
        'feed-5': token('feed-5'),
        'feed-6': token('feed-6'),
        'on-feed': token('on-feed'),
      },
      // The type scale: four sizes, and nothing in between. Headlines and
      // preview text are serif (Design in CLAUDE.md); the rest is the
      // system sans.
      fontFamily: {
        serif: ['ui-serif', 'Charter', '"Iowan Old Style"', 'Georgia', 'serif'],
        sans: ['system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        small: ['0.875rem', { lineHeight: '1.25rem' }],
        body: ['1rem', { lineHeight: '1.5rem' }],
        heading: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        title: ['1.75rem', { lineHeight: '2.25rem', fontWeight: '700' }],
      },
    },
  },
  plugins: [],
};
