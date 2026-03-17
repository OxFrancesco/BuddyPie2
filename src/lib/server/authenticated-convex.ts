export async function getAuthenticatedConvexClient() {
  const [{ auth }, { ConvexHttpClient }] = await Promise.all([
    import('@clerk/tanstack-react-start/server'),
    import('convex/browser'),
  ])
  const session = await auth()

  if (!session.userId) {
    throw new Error('You must be signed in to continue.')
  }

  const token = await session.getToken({ template: 'convex' })
  const convexUrl = process.env.VITE_CONVEX_URL

  if (!token) {
    throw new Error('Your Convex auth token could not be created.')
  }

  if (!convexUrl) {
    throw new Error('VITE_CONVEX_URL is not configured on the server.')
  }

  const convex = new ConvexHttpClient(convexUrl)
  convex.setAuth(token)

  return {
    convex,
    convexUrl,
    token,
    userId: session.userId,
  }
}
