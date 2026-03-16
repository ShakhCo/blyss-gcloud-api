import { Router } from 'express'
import { db } from '../db/db.js'
import { authenticate } from '../middleware/authenticate.js'

const router = Router()

// Apply JWT authentication to all admin routes
router.use(authenticate)

/**
 * Middleware: Only allow requests from the designated admin phone number
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.phone_number !== process.env.ADMIN_PHONE) {
    return res.status(403).json({ error: 'Admin access required', error_code: 'FORBIDDEN' })
  }
  next()
}

router.use(requireAdmin)

/**
 * Pagination helper — builds the pagination metadata object
 */
function paginate(page, pageSize, total) {
  const totalPages = Math.ceil(total / pageSize) || 1
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_prev: page > 1,
  }
}

/**
 * Convert a Firestore Timestamp or Date to ISO string safely
 */
function toIso(value) {
  if (!value) return null
  if (typeof value.toDate === 'function') return value.toDate().toISOString()
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

// ---------------------------------------------------------------------------
// GET /admin/stats
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)

    // Week start (Monday)
    const dayOfWeek = now.getDay() // 0 = Sunday
    const diffToMonday = (dayOfWeek + 6) % 7
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - diffToMonday)
    const weekStartStr = weekStart.toISOString().slice(0, 10)

    // Month start
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    // Thirty days ago
    const thirtyDaysAgo = new Date(now)
    thirtyDaysAgo.setDate(now.getDate() - 30)
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10)

    // Fetch businesses (all)
    const businessesSnap = await db.collection('businesses').get()
    const businesses = businessesSnap.docs.map((d) => ({ id: d.id, ...d.data() }))

    // Fetch users (all business owners)
    const usersSnap = await db.collection('business_owners').get()

    // Booking counts
    const bookingsTodaySnap = await db
      .collection('bookings')
      .where('booking_date', '>=', todayStr)
      .where('booking_date', '<=', todayStr)
      .get()

    const bookingsWeekSnap = await db
      .collection('bookings')
      .where('booking_date', '>=', weekStartStr)
      .get()

    const bookingsMonthSnap = await db
      .collection('bookings')
      .where('booking_date', '>=', monthStartStr)
      .get()

    // Booking volume — last 30 days
    const volumeSnap = await db
      .collection('bookings')
      .where('booking_date', '>=', thirtyDaysAgoStr)
      .get()

    const volumeMap = {}
    const topBizMap = {}
    volumeSnap.docs.forEach((d) => {
      const data = d.data()
      const date = data.booking_date
      if (date) {
        volumeMap[date] = (volumeMap[date] || 0) + 1
      }
      if (data.business_id) {
        if (!topBizMap[data.business_id]) {
          topBizMap[data.business_id] = { id: data.business_id, business_name: data.business_name || '', booking_count: 0 }
        }
        topBizMap[data.business_id].booking_count += 1
      }
    })

    const bookingVolume = Object.entries(volumeMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Top 5 businesses by booking count — join with business_status
    const bizStatusMap = {}
    businesses.forEach((b) => {
      bizStatusMap[b.id] = b.business_status || 'unverified'
    })

    const topBusinesses = Object.values(topBizMap)
      .sort((a, b) => b.booking_count - a.booking_count)
      .slice(0, 5)
      .map((b) => ({ ...b, business_status: bizStatusMap[b.id] || 'unverified' }))

    // Business status counts
    const statusCounts = { active: 0, suspended: 0, unverified: 0 }
    businesses.forEach((b) => {
      const s = b.business_status || 'unverified'
      if (s in statusCounts) statusCounts[s] += 1
      else statusCounts.unverified += 1
    })

    // Recent activity — last 3 bookings + last 3 signups + last 4 reviews
    const recentBookingsSnap = await db
      .collection('bookings')
      .orderBy('created_at', 'desc')
      .limit(3)
      .get()

    const recentSignupsSnap = await db
      .collection('business_owners')
      .orderBy('created_at', 'desc')
      .limit(3)
      .get()

    const recentReviewsSnap = await db
      .collection('reviews')
      .orderBy('submitted_at', 'desc')
      .limit(4)
      .get()

    const recentActivity = []

    recentBookingsSnap.docs.forEach((d) => {
      const data = d.data()
      recentActivity.push({
        type: 'booking',
        id: d.id,
        description: `Booking by ${data.customer_name || 'unknown'} at ${data.business_name || 'unknown'}`,
        timestamp: toIso(data.created_at),
        business_name: data.business_name || null,
        customer_name: data.customer_name || null,
      })
    })

    recentSignupsSnap.docs.forEach((d) => {
      const data = d.data()
      recentActivity.push({
        type: 'signup',
        id: d.id,
        description: `New business owner: ${data.first_name || ''} ${data.last_name || ''}`.trim(),
        timestamp: toIso(data.created_at),
        customer_name: `${data.first_name || ''} ${data.last_name || ''}`.trim() || null,
      })
    })

    recentReviewsSnap.docs.forEach((d) => {
      const data = d.data()
      recentActivity.push({
        type: 'review',
        id: d.id,
        description: `Review from ${data.customer_name || 'unknown'}`,
        timestamp: toIso(data.submitted_at),
        business_name: null,
        customer_name: data.customer_name || null,
      })
    })

    recentActivity.sort((a, b) => {
      if (!a.timestamp) return 1
      if (!b.timestamp) return -1
      return b.timestamp.localeCompare(a.timestamp)
    })

    return res.json({
      kpi: {
        total_businesses: businesses.length,
        total_users: usersSnap.size,
        bookings_today: bookingsTodaySnap.size,
        bookings_this_week: bookingsWeekSnap.size,
        bookings_this_month: bookingsMonthSnap.size,
      },
      business_status_counts: statusCounts,
      booking_volume: bookingVolume,
      top_businesses: topBusinesses,
      recent_activity: recentActivity.slice(0, 10),
    })
  } catch (err) {
    console.error('GET /admin/stats error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

// ---------------------------------------------------------------------------
// GET /admin/businesses
// ---------------------------------------------------------------------------
router.get('/businesses', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.page_size) || 20
    const search = req.query.search || ''
    const status = req.query.status || ''

    let query = db.collection('businesses')
    if (status) {
      query = query.where('business_status', '==', status)
    }

    const snap = await query.get()
    let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

    // Client-side search filter (Firestore doesn't support LIKE)
    if (search) {
      const lower = search.toLowerCase()
      docs = docs.filter(
        (d) => d.business_name && d.business_name.toLowerCase().includes(lower)
      )
    }

    const total = docs.length
    const start = (page - 1) * pageSize
    const pageData = docs.slice(start, start + pageSize).map((d) => ({
      id: d.id,
      business_name: d.business_name || null,
      business_type: d.business_type || null,
      business_status: d.business_status || null,
      business_phone_number: d.business_phone_number || null,
      tenant_url: d.tenant_url || null,
      avatar_url: d.avatar_url || null,
      date_created: toIso(d.date_created),
    }))

    return res.json({
      data: pageData,
      pagination: paginate(page, pageSize, total),
    })
  } catch (err) {
    console.error('GET /admin/businesses error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

// ---------------------------------------------------------------------------
// GET /admin/users
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.page_size) || 20
    const search = req.query.search || ''

    const snap = await db.collection('business_owners').get()
    let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

    if (search) {
      const lower = search.toLowerCase()
      docs = docs.filter((d) => {
        const firstName = (d.first_name || '').toLowerCase()
        const lastName = (d.last_name || '').toLowerCase()
        const phone = (d.phone_number || '').toLowerCase()
        return firstName.includes(lower) || lastName.includes(lower) || phone.includes(lower)
      })
    }

    const total = docs.length
    const start = (page - 1) * pageSize
    const pageData = docs.slice(start, start + pageSize).map((d) => ({
      id: d.id,
      first_name: d.first_name || null,
      last_name: d.last_name || null,
      phone_number: d.phone_number || null,
      telegram_id: d.telegram_id || null,
      is_verified: d.is_verified ?? false,
      created_at: toIso(d.created_at),
    }))

    return res.json({
      data: pageData,
      pagination: paginate(page, pageSize, total),
    })
  } catch (err) {
    console.error('GET /admin/users error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

// ---------------------------------------------------------------------------
// GET /admin/bookings
// ---------------------------------------------------------------------------
router.get('/bookings', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.page_size) || 20
    const businessId = req.query.business_id || ''
    const search = req.query.search || ''
    const status = req.query.status || ''
    const dateFrom = req.query.date_from || ''
    const dateTo = req.query.date_to || ''

    // Apply most selective server-side filters
    let query = db.collection('bookings')
    if (businessId) {
      query = query.where('business_id', '==', businessId)
    } else if (dateFrom) {
      query = query.where('booking_date', '>=', dateFrom)
      if (dateTo) {
        query = query.where('booking_date', '<=', dateTo)
      }
    }

    const snap = await query.get()
    let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

    // Apply remaining filters in JS
    if (businessId && dateFrom) {
      docs = docs.filter((d) => !dateFrom || d.booking_date >= dateFrom)
      if (dateTo) {
        docs = docs.filter((d) => d.booking_date <= dateTo)
      }
    }
    if (status) {
      docs = docs.filter((d) => d.status === status)
    }
    if (search) {
      const lower = search.toLowerCase()
      docs = docs.filter((d) => d.business_name && d.business_name.toLowerCase().includes(lower))
    }

    // Sort by most recent first
    docs.sort((a, b) => (b.booking_date || '').localeCompare(a.booking_date || ''))

    const total = docs.length
    const start = (page - 1) * pageSize
    const pageData = docs.slice(start, start + pageSize).map((d) => ({
      id: d.id,
      business_id: d.business_id || null,
      business_name: d.business_name || null,
      user_id: d.user_id || null,
      customer_name: d.customer_name || null,
      customer_phone: d.customer_phone || null,
      booking_date: d.booking_date || null,
      status: d.status || null,
      total_price: d.total_price ?? null,
      total_duration_minutes: d.total_duration_minutes ?? null,
      notes: d.notes || null,
      created_at: toIso(d.created_at),
      updated_at: toIso(d.updated_at),
    }))

    return res.json({
      data: pageData,
      pagination: paginate(page, pageSize, total),
    })
  } catch (err) {
    console.error('GET /admin/bookings error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

// ---------------------------------------------------------------------------
// GET /admin/bookings/:id
// ---------------------------------------------------------------------------
router.get('/bookings/:id', async (req, res) => {
  try {
    const doc = await db.collection('bookings').doc(req.params.id).get()
    if (!doc.exists) {
      return res.status(404).json({ error: 'Not found', error_code: 'NOT_FOUND' })
    }
    return res.json({ id: doc.id, ...doc.data() })
  } catch (err) {
    console.error('GET /admin/bookings/:id error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

// ---------------------------------------------------------------------------
// GET /admin/reviews
// ---------------------------------------------------------------------------
router.get('/reviews', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.page_size) || 20
    const businessId = req.query.business_id || ''
    const ratingParam = req.query.rating
    const dateFrom = req.query.date_from || ''

    let query = db.collection('reviews')
    if (businessId) {
      query = query.where('business_id', '==', businessId)
    }

    const snap = await query.get()
    let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))

    // Apply remaining filters in JS
    if (dateFrom) {
      docs = docs.filter((d) => {
        const submittedAt = toIso(d.submitted_at)
        return submittedAt && submittedAt.slice(0, 10) >= dateFrom
      })
    }

    if (ratingParam !== undefined && ratingParam !== '') {
      const ratingValue = parseInt(ratingParam, 10)
      if (!isNaN(ratingValue)) {
        docs = docs.filter(
          (d) =>
            Array.isArray(d.items) && d.items.some((item) => item.rating === ratingValue)
        )
      }
    }

    const total = docs.length
    const start = (page - 1) * pageSize
    const pageData = docs.slice(start, start + pageSize).map((d) => ({
      id: d.id,
      business_id: d.business_id || null,
      customer_name: d.customer_name || null,
      customer_phone: d.customer_phone || null,
      comment: d.comment || null,
      submitted_at: toIso(d.submitted_at),
      status: d.status || null,
      items: d.items || [],
    }))

    return res.json({
      data: pageData,
      pagination: paginate(page, pageSize, total),
    })
  } catch (err) {
    console.error('GET /admin/reviews error:', err)
    return res.status(500).json({ error: 'Internal server error', error_code: 'INTERNAL_ERROR' })
  }
})

export default router
