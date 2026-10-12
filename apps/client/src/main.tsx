import { ApolloClient, ApolloLink, ApolloProvider, HttpLink, InMemoryCache } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { requireLogin } from './me/LoginModal';
import { anonId } from './me/anonId';
import { getLang } from './i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPage } from './admin/AdminPage';
import { App } from './App';
import './styles/theme.scss';

export const client = new ApolloClient({
  // Every request carries this browser's anonymous id, so "내 가게" (saved / visited shops) knows whose it is.
  link: new ApolloLink((operation, forward) => {
    // …and the language, so course notes, reasons and shop texts come back in it.
    operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
      headers: { ...headers, 'x-route-anon': anonId(), 'x-route-lang': getLang() },
    }));
    return forward(operation);
  })
    // Saving, reviews and my page need a Kakao login: the API answers UNAUTHENTICATED and the login dialog opens.
    .concat(onError(({ graphQLErrors }) => {
      if (graphQLErrors?.some((e) => e.extensions?.code === 'UNAUTHENTICATED')) requireLogin();
    }))
    .concat(new HttpLink({ uri: '/graphql' })),
  cache: new InMemoryCache({
    typePolicies: { MyShopState: { keyFields: ['shopId'] } },
  }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApolloProvider client={client}>
      {/* No router: the admin page is the only other screen. */}
      {window.location.pathname.startsWith('/admin') ? <AdminPage /> : <App />}
    </ApolloProvider>
  </StrictMode>,
);
