/**
 * TDD tests for admin routes (02-01)
 *
 * These tests verify:
 * 1. requireAdmin blocks non-admin phone with 403
 * 2. requireAdmin allows ADMIN_PHONE
 * 3. GET /admin/stats returns correct shape
 * 4. GET /admin/businesses paginates correctly
 * 5. GET /admin/bookings filters by status
 * 6. GET /admin/reviews filters by rating
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'

// ---- Hoisted mocks so they're available inside vi.mock() factory ----
const { mockCollection, mockUserDoc, mockAdminUserDoc } = vi.hoisted(() => {
  const mockAdminUserDoc = {
    exists: true,
    id: 'admin-user-id',
    data: () => ({
      first_name: 'Admin',
      last_name: 'User',
      phone_number: '998918570204',
      is_verified: true,
      user_type: 'business_owner',
    }),
  }

  const mockUserDoc = {
    exists: true,
    id: 'user123',
    data: () => ({
      first_name: 'Test',
      last_name: 'User',
      phone_number: '998901234567',
      is_verified: true,
      user_type: 'business_owner',
    }),
  }

  // Shared queryable chain helper
  function makeQueryChain(docs = []) {
    const snapshot = {
      docs: docs.map((d) => ({
        id: d.id || 'doc-id',
        data: () => d,
        exists: true,
      })),
      empty: docs.length === 0,
      size: docs.length,
    }
    const chain = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue(snapshot),
      _snapshot: snapshot,
    }
    return chain
  }

  // Default businesses data
  const businessDocs = [
    { id: 'biz1', business_name: 'Salon Alpha', business_status: 'active', date_created: { toDate: () => new Date('2024-01-01') } },
    { id: 'biz2', business_name: 'Barber Beta', business_status: 'suspended', date_created: { toDate: () => new Date('2024-02-01') } },
    { id: 'biz3', business_name: 'Salon Gamma', business_status: 'unverified', date_created: { toDate: () => new Date('2024-03-01') } },
  ]

  // Default booking docs
  const bookingDocs = [
    { id: 'b1', business_id: 'biz1', business_name: 'Salon Alpha', status: 'confirmed', booking_date: '2024-06-01', customer_name: 'Alice', created_at: { toDate: () => new Date('2024-06-01') } },
    { id: 'b2', business_id: 'biz2', business_name: 'Barber Beta', status: 'pending', booking_date: '2024-06-02', customer_name: 'Bob', created_at: { toDate: () => new Date('2024-06-02') } },
    { id: 'b3', business_id: 'biz1', business_name: 'Salon Alpha', status: 'cancelled', booking_date: '2024-06-03', customer_name: 'Carol', created_at: { toDate: () => new Date('2024-06-03') } },
  ]

  // Default review docs
  const reviewDocs = [
    {
      id: 'r1',
      business_id: 'biz1',
      customer_name: 'Alice',
      customer_phone: '111',
      comment: 'Great',
      submitted_at: { toDate: () => new Date('2024-06-01') },
      status: 'submitted',
      items: [{ service_name: 'Cut', employee_name: 'Bob', rating: 4, price: 50000 }],
    },
    {
      id: 'r2',
      business_id: 'biz2',
      customer_name: 'Bob',
      customer_phone: '222',
      comment: 'Ok',
      submitted_at: { toDate: () => new Date('2024-06-02') },
      status: 'submitted',
      items: [{ service_name: 'Shave', employee_name: 'Alice', rating: 2, price: 30000 }],
    },
  ]

  // Default owner docs
  const ownerDocs = [
    { id: 'o1', first_name: 'Jane', last_name: 'Doe', phone_number: '998991111111', telegram_id: '1111', is_verified: true, created_at: { toDate: () => new Date('2024-01-01') } },
    { id: 'o2', first_name: 'John', last_name: 'Smith', phone_number: '998992222222', telegram_id: '2222', is_verified: false, created_at: { toDate: () => new Date('2024-02-01') } },
  ]

  function makeDocSnapshot(docs) {
    return {
      docs: docs.map((d) => ({ id: d.id || 'doc-id', data: () => d, exists: true })),
      empty: docs.length === 0,
      size: docs.length,
    }
  }

  const mockCollection = vi.fn((collectionName) => {
    // For authenticate middleware — business_owners lookup
    if (collectionName === 'business_owners') {
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue(mockAdminUserDoc),
        }),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot(ownerDocs)),
      }
    }
    if (collectionName === 'users') {
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue(mockUserDoc),
        }),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot([])),
      }
    }
    if (collectionName === 'businesses') {
      return {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot(businessDocs)),
      }
    }
    if (collectionName === 'bookings') {
      const bookingChain = {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot(bookingDocs)),
      }
      return bookingChain
    }
    if (collectionName === 'reviews') {
      return {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot(reviewDocs)),
      }
    }
    return {
      doc: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ exists: false }),
        set: vi.fn().mockResolvedValue(undefined),
      }),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue(makeDocSnapshot([])),
      add: vi.fn().mockResolvedValue({ id: 'mock-doc-id' }),
    }
  })

  return { mockCollection, mockUserDoc, mockAdminUserDoc }
})

// ---- Mock Firestore ----
vi.mock('../db/db.js', () => ({
  db: {
    collection: mockCollection,
  },
}))

// ---- Mock eskiz SMS ----
vi.mock('../utils/eskiz.js', () => ({
  sendOtpSms: vi.fn().mockResolvedValue({ success: true, delivery_method: 'sms' }),
}))

import app from '../server.js'

const JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-abc123'
const API_SECRET_VAL = 'test-api-secret-at-least-32-chars-long-abc123'
const ADMIN_PHONE = '998918570204'

function makeAccessToken(phone = ADMIN_PHONE, userId = 'admin-user-id') {
  return jwt.sign(
    { user_id: userId, user_type: 'business_owner', type: 'access', phone_number: phone },
    JWT_SECRET,
    { expiresIn: '24h' }
  )
}

function makeNonAdminAccessToken() {
  return makeAccessToken('998901234567', 'user123')
}

function makeHmacHeaders(bodyStr = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const message = bodyStr + timestamp
  const signature = crypto.createHmac('sha256', API_SECRET_VAL).update(message).digest('hex')
  return { 'x-timestamp': timestamp, 'x-signature': signature }
}

describe('Admin routes (02-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ADMIN_PHONE = ADMIN_PHONE

    // Reset mockCollection with full default implementation
    function makeDocSnapshot(docs) {
      return {
        docs: docs.map((d) => ({ id: d.id || 'doc-id', data: () => d, exists: true })),
        empty: docs.length === 0,
        size: docs.length,
      }
    }

    const businessDocs = [
      { id: 'biz1', business_name: 'Salon Alpha', business_status: 'active', date_created: { toDate: () => new Date('2024-01-01') } },
      { id: 'biz2', business_name: 'Barber Beta', business_status: 'suspended', date_created: { toDate: () => new Date('2024-02-01') } },
      { id: 'biz3', business_name: 'Salon Gamma', business_status: 'unverified', date_created: { toDate: () => new Date('2024-03-01') } },
    ]
    const bookingDocs = [
      { id: 'b1', business_id: 'biz1', business_name: 'Salon Alpha', status: 'confirmed', booking_date: '2024-06-01', customer_name: 'Alice', created_at: { toDate: () => new Date('2024-06-01') } },
      { id: 'b2', business_id: 'biz2', business_name: 'Barber Beta', status: 'pending', booking_date: '2024-06-02', customer_name: 'Bob', created_at: { toDate: () => new Date('2024-06-02') } },
      { id: 'b3', business_id: 'biz1', business_name: 'Salon Alpha', status: 'cancelled', booking_date: '2024-06-03', customer_name: 'Carol', created_at: { toDate: () => new Date('2024-06-03') } },
    ]
    const reviewDocs = [
      {
        id: 'r1',
        business_id: 'biz1',
        customer_name: 'Alice',
        customer_phone: '111',
        comment: 'Great',
        submitted_at: { toDate: () => new Date('2024-06-01') },
        status: 'submitted',
        items: [{ service_name: 'Cut', employee_name: 'Bob', rating: 4, price: 50000 }],
      },
      {
        id: 'r2',
        business_id: 'biz2',
        customer_name: 'Bob',
        customer_phone: '222',
        comment: 'Ok',
        submitted_at: { toDate: () => new Date('2024-06-02') },
        status: 'submitted',
        items: [{ service_name: 'Shave', employee_name: 'Alice', rating: 2, price: 30000 }],
      },
    ]
    const ownerDocs = [
      { id: 'o1', first_name: 'Jane', last_name: 'Doe', phone_number: '998991111111', telegram_id: '1111', is_verified: true, created_at: { toDate: () => new Date('2024-01-01') } },
      { id: 'o2', first_name: 'John', last_name: 'Smith', phone_number: '998992222222', telegram_id: '2222', is_verified: false, created_at: { toDate: () => new Date('2024-02-01') } },
    ]

    mockCollection.mockImplementation((collectionName) => {
      if (collectionName === 'business_owners') {
        return {
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue(mockAdminUserDoc),
          }),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue(makeDocSnapshot(ownerDocs)),
        }
      }
      if (collectionName === 'users') {
        return {
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue(mockUserDoc),
          }),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue(makeDocSnapshot([])),
        }
      }
      if (collectionName === 'businesses') {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue(makeDocSnapshot(businessDocs)),
        }
      }
      if (collectionName === 'bookings') {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue(makeDocSnapshot(bookingDocs)),
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue({ exists: true, id: 'b1', data: () => bookingDocs[0] }),
          }),
        }
      }
      if (collectionName === 'reviews') {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue(makeDocSnapshot(reviewDocs)),
        }
      }
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({ exists: false }),
          set: vi.fn().mockResolvedValue(undefined),
        }),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue(makeDocSnapshot([])),
        add: vi.fn().mockResolvedValue({ id: 'mock-doc-id' }),
      }
    })
  })

  // ---- 1. requireAdmin guard ----

  describe('requireAdmin guard', () => {
    it('blocks non-admin phone with 403 FORBIDDEN', async () => {
      const token = makeNonAdminAccessToken()
      const hmac = makeHmacHeaders('')

      // Override mockCollection so user lookup for non-admin returns non-admin user
      mockCollection.mockImplementation((collectionName) => {
        if (collectionName === 'business_owners') {
          return {
            doc: vi.fn().mockReturnValue({
              get: vi.fn().mockResolvedValue(mockUserDoc),
            }),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ docs: [], empty: true, size: 0 }),
          }
        }
        return {
          doc: vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: false }) }),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
        }
      })

      const res = await request(app)
        .get('/admin/stats')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(403)
      expect(res.body.error_code).toBe('FORBIDDEN')
    })

    it('allows admin phone through to handler', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/stats')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
    })
  })

  // ---- 2. GET /admin/stats ----

  describe('GET /admin/stats', () => {
    it('returns correct shape with kpi, business_status_counts, booking_volume, top_businesses, recent_activity', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/stats')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('kpi')
      expect(res.body).toHaveProperty('business_status_counts')
      expect(res.body).toHaveProperty('booking_volume')
      expect(res.body).toHaveProperty('top_businesses')
      expect(res.body).toHaveProperty('recent_activity')

      // KPI shape
      expect(res.body.kpi).toHaveProperty('total_businesses')
      expect(res.body.kpi).toHaveProperty('total_users')
      expect(res.body.kpi).toHaveProperty('bookings_today')
      expect(res.body.kpi).toHaveProperty('bookings_this_week')
      expect(res.body.kpi).toHaveProperty('bookings_this_month')

      // business_status_counts shape
      expect(res.body.business_status_counts).toHaveProperty('active')
      expect(res.body.business_status_counts).toHaveProperty('suspended')
      expect(res.body.business_status_counts).toHaveProperty('unverified')

      // booking_volume is array
      expect(Array.isArray(res.body.booking_volume)).toBe(true)

      // top_businesses is array (up to 5)
      expect(Array.isArray(res.body.top_businesses)).toBe(true)
      expect(res.body.top_businesses.length).toBeLessThanOrEqual(5)

      // recent_activity is array (up to 10)
      expect(Array.isArray(res.body.recent_activity)).toBe(true)
      expect(res.body.recent_activity.length).toBeLessThanOrEqual(10)
    })
  })

  // ---- 3. GET /admin/businesses ----

  describe('GET /admin/businesses', () => {
    it('returns paginated data with pagination object', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/businesses?page=1&page_size=2')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      expect(res.body).toHaveProperty('pagination')
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data.length).toBeLessThanOrEqual(2)
      expect(res.body.pagination).toHaveProperty('page', 1)
      expect(res.body.pagination).toHaveProperty('page_size', 2)
      expect(res.body.pagination).toHaveProperty('total')
      expect(res.body.pagination).toHaveProperty('total_pages')
      expect(res.body.pagination).toHaveProperty('has_next')
      expect(res.body.pagination).toHaveProperty('has_prev')
    })

    it('returns correct total when page_size < total docs', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/businesses?page=1&page_size=2')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body.pagination.total).toBe(3)
      expect(res.body.pagination.has_next).toBe(true)
      expect(res.body.pagination.has_prev).toBe(false)
    })
  })

  // ---- 4. GET /admin/bookings with status filter ----

  describe('GET /admin/bookings', () => {
    it('returns paginated bookings list', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/bookings')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      expect(res.body).toHaveProperty('pagination')
    })

    it('filters bookings by status in JS after fetch', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/bookings?status=confirmed')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      // All returned bookings should have status 'confirmed'
      for (const booking of res.body.data) {
        expect(booking.status).toBe('confirmed')
      }
    })

    it('returns 404 for unknown booking id', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      // Override bookings collection so doc().get() returns non-existent doc
      mockCollection.mockImplementation((collectionName) => {
        if (collectionName === 'business_owners') {
          return {
            doc: vi.fn().mockReturnValue({
              get: vi.fn().mockResolvedValue(mockAdminUserDoc),
            }),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ docs: [], empty: true, size: 0 }),
          }
        }
        if (collectionName === 'bookings') {
          return {
            doc: vi.fn().mockReturnValue({
              get: vi.fn().mockResolvedValue({ exists: false }),
            }),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
          }
        }
        return {
          doc: vi.fn().mockReturnValue({
            get: vi.fn().mockResolvedValue({ exists: false }),
          }),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
        }
      })

      const res = await request(app)
        .get('/admin/bookings/nonexistent-id')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(404)
    })
  })

  // ---- 5. GET /admin/reviews with rating filter ----

  describe('GET /admin/reviews', () => {
    it('filters reviews by rating in JS (rating=4 returns only rating-4 reviews)', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/reviews?rating=4')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      // Only reviews with at least one item having rating 4 should be returned
      for (const review of res.body.data) {
        const hasRating4 = review.items.some((item) => item.rating === 4)
        expect(hasRating4).toBe(true)
      }
    })

    it('returns all reviews when no rating filter applied', async () => {
      const token = makeAccessToken()
      const hmac = makeHmacHeaders('')

      const res = await request(app)
        .get('/admin/reviews')
        .set('x-timestamp', hmac['x-timestamp'])
        .set('x-signature', hmac['x-signature'])
        .set('Cookie', `access_token=${token}`)

      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(2)
    })
  })
})
