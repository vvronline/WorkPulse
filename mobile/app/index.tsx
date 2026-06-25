import { Redirect } from 'expo-router';
import { useAuth } from '../src/store/auth';

export default function Index() {
  const { token, hydrated } = useAuth();
  if (!hydrated) return null;
  return <Redirect href={token ? '/(tabs)' : '/login'} />;
}