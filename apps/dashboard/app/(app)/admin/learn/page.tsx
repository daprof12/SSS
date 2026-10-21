'use client';
// Board "Admin learn feed": the platform team writes posts and reviews every post, agencies' included.
import { LearnEditor } from '@/components/LearnEditor';

export default function LearnFeedAdmin() {
  return <LearnEditor base="/admin/learn" agency={null} />;
}
