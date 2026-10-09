import { AuthForm } from '@/components/AuthForm';

/** Same as the login page: the return trip travels in the query string. */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <AuthForm next={next} />;
}
