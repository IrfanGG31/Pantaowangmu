import { db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';

/** A user who already went through onboarding and saw every tip, so bot tests see only the reply under test. */
export function markOnboarded(userId = '42', firstName = 'Uji') {
  upsertUser({ user_id: String(userId), first_name: firstName });
  db.prepare(`
    INSERT INTO user_profile (user_id, onboarding, tips_seen) VALUES (?, 'done', 99)
    ON CONFLICT(user_id) DO UPDATE SET onboarding = 'done', tips_seen = 99
  `).run(String(userId));
}
