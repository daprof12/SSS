// Demo lessons so Learn has something real to show in development. Seeded once.
import type { QuizQuestion } from '@erp/domain';
import type { Queryable } from '../core/db';

interface Seed {
  title: string;
  caption: string;
  topic: string;
  format: 'video' | 'article' | 'quiz';
  language?: string;
  body?: string;
  quiz?: QuizQuestion[];
  durationS?: number;
  source?: 'police' | 'ferma' | 'naptip';
  daysAgo: number;
  likes?: number;
  views?: number;
}

// "Video" lessons without footage play as step cards built from the body, one line per step.
const POSTS: Seed[] = [
  {
    title: 'What to do first in a house fire',
    caption: 'Get low, get out, call from outside. Never go back for belongings.',
    topic: 'fire_safety',
    format: 'video',
    durationS: 30,
    body: 'Shout "Fire!" so everyone wakes up.\nGet low under the smoke and leave by the nearest door.\nClose doors behind you to slow the fire.\nOnce outside, press SOS or call 112.\nNever go back in for phones, money or papers.',
    daysAgo: 1,
    likes: 1240,
    views: 9800,
  },
  {
    title: 'Using a fire extinguisher',
    caption: 'Remember PASS: pull, aim, squeeze, sweep.',
    topic: 'fire_safety',
    format: 'article',
    body: 'Most homes and shops in Nigeria keep a small dry powder extinguisher. It works on small fires only: a pan, a bin, a socket. If the fire is taller than you, or the room is filling with smoke, leave and call for help.\n\nPull the pin. Hold the extinguisher upright and pull the ring out.\n\nAim at the base of the fire, not the flames. The fuel is at the bottom.\n\nSqueeze the handle slowly and keep a firm grip.\n\nSweep from side to side across the base until the fire is out. Step back and watch it: fires can start again.\n\nNever use water on a cooking oil or electrical fire. Turn off the power at the switch if you can do it safely.',
    daysAgo: 6,
    likes: 310,
    views: 4100,
  },
  {
    title: 'Fire safety check',
    caption: 'Three questions. See how ready your home is.',
    topic: 'fire_safety',
    format: 'quiz',
    quiz: [
      { q: 'Smoke is filling the corridor. What do you do?', options: ['Stand up and run', 'Get low and leave', 'Open the windows first'], answer: 1, why: 'Clean air is near the floor. Get low and leave by the nearest exit.' },
      { q: 'A pan of oil catches fire. What do you use?', options: ['Water', 'A damp cloth or lid over it', 'Blow on it'], answer: 1, why: 'Water makes burning oil explode. Cover it and turn off the heat.' },
      { q: 'When do you call for help?', options: ['After you collect your things', 'Once you are outside', 'Only if it spreads'], answer: 1, why: 'Get out first, then call. Belongings can be replaced.' },
    ],
    daysAgo: 3,
    likes: 180,
    views: 2200,
  },
  {
    title: 'How to check a street light is safe before you report it',
    caption: 'Look from a distance. Never touch a fallen cable or a sparking pole.',
    topic: 'road_safety',
    format: 'video',
    durationS: 45,
    body: 'Stand well back from the pole.\nLook for fallen cables, sparks or water around the base.\nIf anything is sparking, keep people away and call 112.\nIf it is just not working, report a public issue with the pole number.',
    source: 'ferma',
    daysAgo: 2,
    likes: 96,
    views: 1300,
  },
  {
    title: 'Spot a one chance bus',
    caption: 'Empty seats at the back, passengers who will not move, and a driver in a hurry.',
    topic: 'crime_prevention',
    format: 'article',
    source: 'police',
    body: 'One chance robbers use a bus or car that looks like normal transport. The "passengers" are part of the gang.\n\nBe careful when the only free seat is in the middle or at the back, or when other passengers will not shift for you.\n\nWatch for a bus that stops for you away from the park, with the conductor rushing you in.\n\nIf you feel unsafe, do not enter. Take a photo of the plate from a distance and report it as a public issue: One chance vehicle.\n\nIf you are already inside and in danger, use SOS. It works with the screen locked and sends your location.',
    daysAgo: 4,
    likes: 820,
    views: 7300,
  },
  {
    title: 'First aid: someone is bleeding',
    caption: 'Press hard on the wound and do not let go until help arrives.',
    topic: 'first_aid',
    format: 'video',
    durationS: 40,
    body: 'Make sure the area is safe for you.\nPress firmly on the wound with a clean cloth.\nIf blood soaks through, add more cloth on top. Do not lift it.\nRaise the arm or leg if nothing is broken.\nKeep pressing until help takes over. Press SOS for medical help.',
    daysAgo: 5,
    likes: 640,
    views: 5100,
  },
  {
    title: 'Is it a scam? The fake bank alert',
    caption: 'Check your balance in your own bank app, not the text message.',
    topic: 'scams_fraud',
    format: 'quiz',
    quiz: [
      { q: 'A buyer shows you a credit alert on their phone. What do you do?', options: ['Release the goods', 'Check your own bank app first', 'Ask them to send it again'], answer: 1, why: 'Alerts can be faked in seconds. Only your bank app shows real money.' },
      { q: 'Someone calls from "your bank" asking for your BVN and OTP. You…', options: ['Give it, they are the bank', 'Hang up and call the number on your card', 'Send only the OTP'], answer: 1, why: 'Banks never ask for your OTP or PIN. Hang up and call them yourself.' },
    ],
    daysAgo: 8,
    likes: 410,
    views: 3900,
  },
  {
    title: 'Wahala for road: wetin you go do first',
    caption: 'Make sure say place safe, then press SOS. No move person wey wound unless fire dey.',
    topic: 'road_safety',
    format: 'article',
    language: 'pcm',
    body: 'If accident happen for road, first check say you yourself dey safe. Park well, on hazard light.\n\nNo carry person wey wound comot unless fire or water dey threaten am. You fit make the wound worse.\n\nPress SOS for the app. E go send where you dey to the people wey fit help.\n\nIf plenty people dey, make one person control traffic so another motor no go jam una.',
    daysAgo: 9,
    likes: 150,
    views: 1800,
  },
  {
    title: 'Signs a child may be trafficked',
    caption: 'A child working long hours, not in school, and afraid to talk to you.',
    topic: 'child_safety',
    format: 'article',
    source: 'naptip',
    body: 'Children who are trafficked are often hidden in plain sight: hawking, working in homes or shops, or moved at night between towns.\n\nWatch for a child who never goes to school, works very long hours, looks underfed or hurt, or seems afraid of the adult with them.\n\nDo not confront the adult. Note the place, time and anything you can safely see.\n\nReport a tip in the app. You can hide your name from the agency. If the child is in danger now, use SOS.',
    daysAgo: 10,
    likes: 530,
    views: 4600,
  },
  {
    title: 'Before the flood: three things to do tonight',
    caption: 'Raise your papers, plan your way out, and keep your phone charged.',
    topic: 'flood_disaster',
    format: 'video',
    durationS: 35,
    body: 'Put birth certificates, IDs and land papers in a nylon bag, up high.\nAgree where your family will meet if you are separated.\nCharge your phone and a power bank before heavy rain.\nNever walk or drive through moving water.',
    daysAgo: 12,
    likes: 270,
    views: 2600,
  },
  {
    title: 'Locking up: the 2-minute night check',
    caption: 'Doors, windows, gate, and the outside light on.',
    topic: 'home_security',
    format: 'quiz',
    quiz: [
      { q: 'Which light helps most at night?', options: ['A light at the gate or door', 'The TV left on', 'No light, so no one sees'], answer: 0, why: 'A lit entrance makes it harder to break in unseen.' },
      { q: 'You hear someone at the window at night. First step?', options: ['Go out to check', 'Press SOS, stay in a locked room', 'Shout at them'], answer: 1, why: 'Stay safe and let help come to you. SOS shares your location.' },
    ],
    daysAgo: 15,
    likes: 120,
    views: 1500,
  },
  {
    title: 'Your rights at a police checkpoint',
    caption: 'Stay calm, ask for the officer’s name, and do not pay for bail at the roadside.',
    topic: 'know_your_rights',
    format: 'article',
    source: 'police',
    body: 'You can be stopped and asked for your papers. Stay calm and keep your hands where the officer can see them.\n\nYou may ask for the officer’s name and number. Officers on duty should wear a name tag.\n\nBail is free. You should not be asked to pay money at a checkpoint.\n\nIf something goes wrong, note the place, time and any names, and report it through the app or the Police complaint line.',
    daysAgo: 20,
    likes: 980,
    views: 8800,
  },
];

export async function seedLearn(c: Queryable, adminId: string, agencies: { police: string; ferma: string; naptip: string }) {
  const have = (await c.query(`select count(*)::int as n from learn_posts`)).rows[0].n;
  if (have > 0) return;
  for (const x of POSTS) {
    await c.query(
      `insert into learn_posts (title, caption, body, quiz, format, topic, language, duration_s, source_agency, state, created_by, reviewed_by, published_at, like_count, view_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'live', $10, $10, now() - make_interval(days => $11), $12, $13)`,
      [
        x.title,
        x.caption,
        x.body ?? null,
        x.quiz ? JSON.stringify(x.quiz) : null,
        x.format,
        x.topic,
        x.language ?? 'en',
        x.durationS ?? (x.format === 'quiz' ? (x.quiz?.length ?? 1) * 20 : x.format === 'article' ? Math.max(30, Math.round(((x.body ?? '').split(/\s+/).length / 200) * 60)) : null),
        x.source ? agencies[x.source] : null,
        adminId,
        x.daysAgo,
        x.likes ?? 0,
        x.views ?? 0,
      ],
    );
  }
}
