export function page(head: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test</title>${head}</head><body>${body}</body></html>`;
}

const FARM_SENTENCES = [
  'Cookies are one of the most loved treats in the world and everyone has a favorite kind.',
  "In today's fast-paced world, it's important to note that baking at home can be a wonderful experience.",
  "Whether you're a beginner or an expert, this guide will help you on your baking journey.",
  'Many people wonder what makes a cookie truly great, and the answer might surprise you.',
  'Baking is a tapestry of flavors, textures and memories that bring families together.',
];

export function repeatParagraphs(sentences: string[], targetWords: number): string {
  const out: string[] = [];
  let words = 0;
  for (let i = 0; words < targetWords; i++) {
    const s = sentences[i % sentences.length]!;
    out.push(`<p>${s}</p>`);
    words += s.split(/\s+/).length;
  }
  return out.join('\n');
}

/** Long preamble, ad slots, stock images, affiliate links, popup script, generic author, stock phrases. */
export const farmRecipe = () =>
  page(
    `<meta name="author" content="admin">
     <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
     <script src="https://scripts.mediavine.com/tags/site.js"></script>
     <script src="https://a.omappapi.com/app/js/api.min.js"></script>`,
    `<nav><a href="/">Home</a><a href="/recipes">Recipes</a></nav>
     <article>
       <h1>The Best Chocolate Chip Cookies Ever</h1>
       ${Array.from({ length: 8 }, () => `<div class="ad-container"><ins class="adsbygoogle"></ins></div>${repeatParagraphs(FARM_SENTENCES, 110)}`).join('\n')}
       <h2>Ingredients</h2>
       <ul><li>1 cup butter</li><li>2 cups flour</li><li>1 tsp baking soda</li><li>2 eggs</li></ul>
       <img src="https://www.shutterstock.com/image-photo/cookies-1.jpg">
       <img src="https://www.shutterstock.com/image-photo/cookies-2.jpg">
       <img src="https://media.istockphoto.com/cookies-3.jpg">
       <p>Shop our picks: <a href="https://amzn.to/abc1">mixer</a> <a href="https://amzn.to/abc2">tray</a>
          <a href="https://amzn.to/abc3">spatula</a> <a href="https://amzn.to/abc4">bowl</a>
          <a href="https://amzn.to/abc5">scale</a> <a href="/about">about us</a> <a href="/contact">contact</a></p>
     </article>
     <footer>© Cookie Hub</footer>`,
  );

/** Named author, first-hand detail up front, numbered steps, original photos, real comments. */
export const blogRecipe = () =>
  page(
    `<meta name="author" content="Maria Lopez">`,
    `<nav><a href="/">Home</a></nav>
     <article>
       <h1>Brown Butter Chocolate Chip Cookies</h1>
       <p>I've baked these cookies every Sunday since 2019, and my version uses 225 g of browned butter and 2 large eggs.</p>
       <p>The trick I learned the hard way: chill the dough for 24 hours. My first batches spread into thin puddles because I skipped it.</p>
       <h2>Ingredients</h2>
       <ul><li>225 g unsalted butter, browned</li><li>200 g dark brown sugar</li><li>50 g white sugar</li><li>2 large eggs</li>
           <li>280 g plain flour</li><li>1 tsp baking soda</li><li>1 tsp flaky salt</li><li>250 g dark chocolate, chopped</li></ul>
       <h2>Method</h2>
       <ol>
         <li>Brown the butter over medium heat for about 6 minutes until it smells nutty.</li>
         <li>Cool it for 15 minutes, then whisk in both sugars.</li>
         <li>Beat in the eggs one at a time.</li>
         <li>Fold in the flour, baking soda and salt.</li>
         <li>Stir through the chocolate.</li>
         <li>Chill the dough for 24 hours.</li>
         <li>Scoop 50 g balls onto a lined tray.</li>
         <li>Bake at 180 °C for 11 minutes, until the edges are golden.</li>
       </ol>
       <p>We tested this with three flours in March 2023. Bread flour gave a chewier cookie, but my kids preferred plain flour, so that is what I use now.</p>
       <p>If your oven runs hot, drop it to 170 °C and check at 9 minutes. I keep an oven thermometer on the middle rack because mine runs about 10 °C high.</p>
       <img src="/uploads/2023/03/cookies-dough.jpg"><img src="/uploads/2023/03/cookies-tray.jpg">
       <img src="/uploads/2023/03/cookies-stack.jpg"><img src="/uploads/2023/03/cookies-broken.jpg">
     </article>
     <section id="comments">
       <div class="comment">Made these last night, the 24 hour chill really works.</div>
       <div class="comment">Swapped half the flour for bread flour, very chewy.</div>
       <div class="comment">My oven runs hot too, 170 worked perfectly.</div>
     </section>
     <footer>© Maria's Kitchen</footer>`,
  );

/** Short, specific, first-person answers from several usernames. */
export const forumThread = () =>
  page(
    '',
    `<main>
       <h1>Oven runs hot, how do you calibrate?</h1>
       <div class="post"><span class="author">breadnerd</span><p>My oven reads 180 °C but my thermometer says 195 °C. I have tried the dial adjustment but it drifts again after a week.</p></div>
       <div class="post"><span class="author">kiln_kate</span><p>I had the same problem. Most ovens have a calibration screw behind the knob. I turned mine 2 notches and it has held for 8 months.</p></div>
       <div class="post"><span class="author">maple_oak</span><p>We replaced the sensor instead. The part cost $18 and took 20 minutes with a screwdriver.</p></div>
       <div class="post"><span class="author">quietbaker</span><p>Check the door seal first. Mine was torn and the oven lost about 15 °C every time the fan kicked in.</p></div>
       <div class="post"><span class="author">breadnerd</span><p>Thanks, the screw fixed it. It is now within 3 °C across the whole rack after 2 weeks.</p></div>
     </main>`,
  );

/** Plain, formulaic English from a non-native writer, with one stock phrase, but concrete and useful. */
export const nonNativeHowTo = () =>
  page(
    `<meta name="author" content="Nguyen Van An">`,
    `<article>
       <h1>How to fix slow Wi-Fi on router model AX3000</h1>
       <p>I have this router since 2021 and I fix the slow Wi-Fi problem many times for my family.</p>
       <p>It is important to note that you need the admin password before you start this steps.</p>
       <ol>
         <li>Open the browser and go to the address 192.168.0.1 on your computer.</li>
         <li>Log in with the admin password that is on the sticker under the router.</li>
         <li>Go to the Wireless menu and choose the 5 GHz band for your devices.</li>
         <li>Change the channel width from 20 MHz to 80 MHz and then save the setting.</li>
         <li>Change the channel number to 36 because this channel is often more free.</li>
         <li>Update the firmware to version 1.2.8 from the official support page.</li>
         <li>Restart the router and wait around 3 minutes before you test again.</li>
         <li>Test the speed again with the same device in the same room as before.</li>
       </ol>
       <p>After these steps my speed go from 40 Mbps to 310 Mbps in the living room.</p>
       <p>If the speed is still slow, you can move the router to a more high place in the house.</p>
       <p>I hope this guide help you, and please ask me in the comment if you have a problem.</p>
     </article>`,
  );

export const tinyPage = () => page('', '<p>Hello world, this page says almost nothing.</p>');
