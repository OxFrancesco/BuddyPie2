import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'expire stale reserve leases',
  { minutes: 5 },
  internal.billing.expireActiveLeases,
  {},
)

export default crons
