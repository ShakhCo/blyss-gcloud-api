import OpenAI from 'openai';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/db.js';
import { sendOtpSms } from './eskiz.js';
import { generateTokenPair } from './jwt.js';
import { resolveDiscount } from './discountResolver.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = { uz: ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'], ru: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'] };

// ─── Helpers ───

function uzbekNow() {
    const now = new Date();
    return new Date(now.getTime() + 5 * 3600000);
}

function uzbekToday() {
    return uzbekNow().toISOString().split('T')[0];
}

function secsToHHMM(s) {
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function localeName(nameObj, lang = 'uz') {
    if (!nameObj) return '';
    if (typeof nameObj === 'string') return nameObj;
    return nameObj[lang] || nameObj.uz || nameObj.ru || '';
}

// ─── Tool definitions ───

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_services',
            description: 'Get list of available services with prices and durations. Call when user asks about services or wants to book.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_available_dates',
            description: 'Get available dates for booking in the next 7 days. Returns which days the business is open.',
            parameters: {
                type: 'object',
                properties: {
                    service_id: { type: 'string', description: 'Service ID to check availability for' },
                },
                required: ['service_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_available_slots',
            description: 'Get available time slots for a specific date and service.',
            parameters: {
                type: 'object',
                properties: {
                    date: { type: 'string', description: 'YYYY-MM-DD' },
                    service_id: { type: 'string', description: 'Service ID' },
                },
                required: ['date', 'service_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_verification_code',
            description: 'Send SMS verification code to phone number. Call when user provides their phone number for booking.',
            parameters: {
                type: 'object',
                properties: {
                    phone_number: { type: 'string', description: 'Phone number like +998901234567' },
                },
                required: ['phone_number'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'verify_code',
            description: 'Verify the OTP code entered by user.',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: '5-digit code' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'register_user',
            description: 'Register a new user with their first name after OTP verification.',
            parameters: {
                type: 'object',
                properties: {
                    first_name: { type: 'string', description: 'User first name' },
                },
                required: ['first_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_booking',
            description: 'Create a booking. User must be authenticated first. Uses pending booking info from session.',
            parameters: {
                type: 'object',
                properties: {
                    date: { type: 'string', description: 'YYYY-MM-DD' },
                    start_time: { type: 'number', description: 'Seconds from midnight' },
                    service_id: { type: 'string', description: 'Service ID' },
                    employee_id: { type: 'string', description: 'Employee ID (optional, auto-assign if omitted)' },
                },
                required: ['date', 'start_time', 'service_id'],
            },
        },
    },
];

// ─── Tool executors ───

async function execGetServices(businessId) {
    const snap = await db.collection('businesses').doc(businessId)
        .collection('services').where('is_active', '==', true).get();
    if (snap.empty) return { services: [], note: 'No active services found.' };
    return {
        services: snap.docs.map(d => {
            const s = d.data();
            return {
                id: d.id,
                name_uz: s.name?.uz || '',
                name_ru: s.name?.ru || '',
                price: s.price,
                duration_minutes: s.duration_minutes,
            };
        }),
    };
}

async function execGetAvailableDates(businessId, serviceId) {
    const businessDoc = await db.collection('businesses').doc(businessId).get();
    if (!businessDoc.exists) return { error: 'Business not found' };
    const wh = businessDoc.data().working_hours || {};
    const today = uzbekToday();
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(uzbekNow());
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const dayName = DAY_NAMES[d.getDay()];
        const hours = wh[dayName];
        const isOpen = hours?.is_open === true;
        dates.push({
            date: dateStr,
            day_uz: DAY_LABELS.uz[d.getDay()],
            day_ru: DAY_LABELS.ru[d.getDay()],
            is_open: isOpen,
            hours: isOpen ? `${secsToHHMM(hours.start)} - ${secsToHHMM(hours.end)}` : 'closed',
            is_today: dateStr === today,
        });
    }
    return { dates: dates.filter(d => d.is_open) };
}

async function execGetAvailableSlots(businessId, date, serviceId) {
    const businessDoc = await db.collection('businesses').doc(businessId).get();
    if (!businessDoc.exists) return { error: 'Business not found' };
    const businessData = businessDoc.data();
    const dateObj = new Date(date);
    const dayName = DAY_NAMES[dateObj.getDay()];
    const bh = businessData.working_hours?.[dayName];
    if (!bh || !bh.is_open) return { slots: [], note: 'Business is closed on this day.' };

    // Get employees with this service
    const empsSnap = await db.collection('businesses').doc(businessId)
        .collection('employees').where('is_accepted', '==', true).get();
    const employees = [];
    for (const empDoc of empsSnap.docs) {
        const empData = empDoc.data();
        const esSnap = await db.collection('businesses').doc(businessId)
            .collection('employees').doc(empDoc.id)
            .collection('employeeServices')
            .where('service_id', '==', serviceId).where('is_active', '==', true).limit(1).get();
        if (!esSnap.empty) {
            employees.push({
                id: empDoc.id,
                working_hours: empData.working_hours || null,
                availability_type: empData.availability_type || 'flexible',
                is_open_now: empData.is_open_now || false,
                allowed: empData.allowed_booking_count_per_slot || 1,
                duration: esSnap.docs[0].data().duration_minutes,
            });
        }
    }
    if (employees.length === 0) return { slots: [], note: 'No employees offer this service.' };

    // Get existing bookings
    const bookingsSnap = await db.collection('bookings')
        .where('business_id', '==', businessId)
        .where('booking_date', '==', date)
        .where('status', 'in', ['pending', 'confirmed']).get();
    const empBookings = new Map();
    for (const bDoc of bookingsSnap.docs) {
        for (const item of bDoc.data().items || []) {
            if (!item.employee_id || !item.start_time) continue;
            if (!empBookings.has(item.employee_id)) empBookings.set(item.employee_id, []);
            const tp = item.start_time.split('T')[1];
            const [h, m] = tp.split(':').map(Number);
            const ss = h * 3600 + m * 60;
            empBookings.get(item.employee_id).push({ start: ss, end: ss + (item.duration_minutes || 30) * 60 });
        }
    }

    // Calculate available slots
    const todayUzb = uzbekToday();
    let minStart = bh.start;
    if (date === todayUzb) {
        const uNow = uzbekNow();
        const currentSecs = uNow.getHours() * 3600 + uNow.getMinutes() * 60;
        minStart = Math.max(bh.start, Math.ceil((currentSecs + 900) / 900) * 900);
    }
    const slots = [];
    for (let t = minStart; t < bh.end; t += 900) {
        for (const emp of employees) {
            const slotEnd = t + emp.duration * 60;
            if (emp.availability_type === 'flexible') {
                if (date !== todayUzb || !emp.is_open_now) continue;
                if (slotEnd > bh.end) continue;
            } else {
                const eh = emp.working_hours?.[dayName];
                if (eh && !eh.is_open) continue;
                if (eh && (t < eh.start || slotEnd > eh.end)) continue;
                if (slotEnd > bh.end) continue;
            }
            const eb = empBookings.get(emp.id) || [];
            let cnt = 0;
            for (const b of eb) { if (!(slotEnd <= b.start || t >= b.end)) cnt++; }
            if (cnt < emp.allowed) { slots.push(t); break; }
        }
    }

    return {
        slots: slots.map(s => ({ start_time: s, label: secsToHHMM(s) })),
        total: slots.length,
    };
}

async function execSendOtp(phoneNumber, session) {
    // Normalize phone
    let phone = phoneNumber.replace(/[\s\-\(\)]/g, '');
    if (phone.startsWith('998')) phone = '+' + phone;
    if (!phone.startsWith('+998') || phone.length !== 13) {
        return { error: 'Invalid phone number format. Expected +998XXXXXXXXX' };
    }

    // Rate limit check
    const recentSnap = await db.collection('otps')
        .where('phone_number', '==', phone)
        .orderBy('created_at', 'desc').limit(1).get();
    if (!recentSnap.empty) {
        const elapsed = Date.now() - recentSnap.docs[0].data().created_at.toDate().getTime();
        if (elapsed < 60000) {
            return { error: `Please wait ${Math.ceil((60000 - elapsed) / 1000)} seconds before requesting another code.` };
        }
    }

    const otpCode = crypto.randomInt(10000, 100000).toString();
    const result = await sendOtpSms(phone, otpCode, 'user');
    if (!result.success) return { error: 'Failed to send verification code. Please try again.' };

    const otpHash = await bcrypt.hash(otpCode, 10);
    const otpRef = await db.collection('otps').add({
        phone_number: phone,
        otp_code: otpHash,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000),
        used: false,
        attempts: 0,
        user_type: 'user',
    });

    session.phone_number = phone;
    session.otp_id = otpRef.id;
    return { success: true, phone_number: phone, delivery_method: result.delivery_method };
}

async function execVerifyOtp(code, session) {
    if (!session.otp_id || !session.phone_number) {
        return { error: 'No verification code was sent. Please provide your phone number first.' };
    }

    const otpDoc = await db.collection('otps').doc(session.otp_id).get();
    if (!otpDoc.exists) return { error: 'Verification code expired. Please request a new one.' };
    const otpData = otpDoc.data();

    if (otpData.used) return { error: 'Code already used. Please request a new one.' };
    if ((otpData.attempts || 0) >= 5) {
        await otpDoc.ref.update({ used: true });
        return { error: 'Too many attempts. Please request a new code.' };
    }
    if (otpData.expires_at.toDate() < new Date()) return { error: 'Code expired. Please request a new one.' };

    const stored = otpData.otp_code;
    const isMatch = stored.startsWith('$2') ? await bcrypt.compare(String(code), stored) : stored === String(code);
    if (!isMatch) {
        await otpDoc.ref.update({ attempts: (otpData.attempts || 0) + 1 });
        return { error: 'Invalid code. Please try again.' };
    }

    // Check if user exists
    const usersSnap = await db.collection('users')
        .where('phone_number', '==', session.phone_number).limit(1).get();

    if (usersSnap.empty) {
        await otpDoc.ref.update({ verified: true, verified_at: new Date() });
        session.needs_registration = true;
        return { success: true, needs_registration: true, message: 'Phone verified. User needs to provide their name to register.' };
    }

    // Existing user
    await otpDoc.ref.update({ used: true });
    const userData = usersSnap.docs[0].data();
    session.user_id = usersSnap.docs[0].id;
    session.first_name = userData.first_name || '';
    return {
        success: true,
        needs_registration: false,
        user_id: session.user_id,
        first_name: session.first_name,
        message: `User verified: ${session.first_name}`,
    };
}

async function execRegisterUser(firstName, session) {
    if (!session.phone_number || !session.otp_id) {
        return { error: 'Phone not verified. Please verify your phone first.' };
    }
    const otpDoc = await db.collection('otps').doc(session.otp_id).get();
    if (!otpDoc.exists || !otpDoc.data().verified) {
        return { error: 'Phone not verified.' };
    }
    await otpDoc.ref.update({ used: true });

    const now = new Date();
    const userRef = db.collection('users').doc();
    await userRef.set({
        phone_number: session.phone_number,
        first_name: firstName,
        last_name: '',
        is_verified: true,
        created_at: now,
        updated_at: now,
    });
    session.user_id = userRef.id;
    session.first_name = firstName;
    session.needs_registration = false;
    return { success: true, user_id: userRef.id, first_name: firstName };
}

async function execCreateBooking(businessId, session, { date, start_time, service_id, employee_id }) {
    if (!session.user_id) {
        return { error: 'User must be authenticated before booking. Ask for phone number.' };
    }

    const userDoc = await db.collection('users').doc(session.user_id).get();
    if (!userDoc.exists) return { error: 'User not found.' };
    const userData = userDoc.data();

    const businessDoc = await db.collection('businesses').doc(businessId).get();
    if (!businessDoc.exists) return { error: 'Business not found.' };
    const businessData = businessDoc.data();

    const dateObj = new Date(date);
    const dayName = DAY_NAMES[dateObj.getDay()];
    const bh = businessData.working_hours?.[dayName];
    if (!bh || !bh.is_open) return { error: 'Business is closed on this day.' };

    // Get service
    const serviceDoc = await db.collection('businesses').doc(businessId)
        .collection('services').doc(service_id).get();
    if (!serviceDoc.exists) return { error: 'Service not found.' };
    const serviceData = serviceDoc.data();

    // Find available employee
    const empsSnap = await db.collection('businesses').doc(businessId)
        .collection('employees').where('is_accepted', '==', true).get();

    // Get owner names
    const ownerIds = new Set();
    empsSnap.docs.forEach(d => { if (d.data().business_owner_id) ownerIds.add(d.data().business_owner_id); });
    const ownersMap = new Map();
    await Promise.all([...ownerIds].map(async id => {
        const od = await db.collection('business_owners').doc(id).get();
        if (od.exists) ownersMap.set(id, od.data());
    }));

    const todayUzb = uzbekToday();
    const bookingsSnap = await db.collection('bookings')
        .where('business_id', '==', businessId)
        .where('booking_date', '==', date)
        .where('status', 'in', ['pending', 'confirmed']).get();

    const empBookings = new Map();
    for (const bDoc of bookingsSnap.docs) {
        for (const item of bDoc.data().items || []) {
            if (!item.employee_id || !item.start_time) continue;
            if (!empBookings.has(item.employee_id)) empBookings.set(item.employee_id, []);
            const tp = item.start_time.split('T')[1];
            const [h, m] = tp.split(':').map(Number);
            const ss = h * 3600 + m * 60;
            empBookings.get(item.employee_id).push({ start: ss, end: ss + (item.duration_minutes || 30) * 60 });
        }
    }

    let selectedEmp = null;
    let empServiceData = null;

    for (const empDoc of empsSnap.docs) {
        if (employee_id && empDoc.id !== employee_id) continue;
        const empData = empDoc.data();
        const esSnap = await db.collection('businesses').doc(businessId)
            .collection('employees').doc(empDoc.id)
            .collection('employeeServices')
            .where('service_id', '==', service_id).where('is_active', '==', true).limit(1).get();
        if (esSnap.empty) continue;

        const esd = esSnap.docs[0].data();
        const slotEnd = start_time + esd.duration_minutes * 60;

        if (empData.availability_type === 'flexible') {
            if (date !== todayUzb || !empData.is_open_now) continue;
            if (slotEnd > bh.end) continue;
        } else {
            const eh = empData.working_hours?.[dayName];
            if (eh && !eh.is_open) continue;
            if (eh && (start_time < eh.start || slotEnd > eh.end)) continue;
            if (slotEnd > bh.end) continue;
        }

        const eb = empBookings.get(empDoc.id) || [];
        let cnt = 0;
        for (const b of eb) { if (!(slotEnd <= b.start || start_time >= b.end)) cnt++; }
        if (cnt >= (empData.allowed_booking_count_per_slot || 1)) continue;

        const ownerData = ownersMap.get(empData.business_owner_id) || {};
        selectedEmp = {
            id: empDoc.id,
            first_name: ownerData.first_name || '',
            last_name: ownerData.last_name || '',
        };
        empServiceData = esd;
        break;
    }

    if (!selectedEmp) return { error: 'No available employee for this time slot. Please choose another time.' };

    const slotEnd = start_time + empServiceData.duration_minutes * 60;
    const startStr = `${date}T${secsToHHMM(start_time)}`;
    const endStr = `${date}T${secsToHHMM(slotEnd)}`;
    const empName = [selectedEmp.first_name, selectedEmp.last_name].filter(Boolean).join(' ');
    const customerName = [userData.first_name, userData.last_name].filter(Boolean).join(' ') || 'Website User';

    // Resolve discount
    let itemPrice = empServiceData.price;
    let discountApplied = null;
    try {
        const dr = await resolveDiscount({
            businessId, employeeId: selectedEmp.id, serviceId: service_id,
            basePrice: empServiceData.price, bookingDate: date, bookingTime: start_time,
            customerPhone: session.phone_number,
        });
        if (dr) { itemPrice = dr.final_price; discountApplied = dr.discount; }
    } catch (e) { /* ignore */ }

    const bookingId = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const bookingPayload = {
        business_id: businessId,
        business_name: businessData.business_name,
        user_id: session.user_id,
        customer_name: customerName,
        customer_phone: userData.phone_number || '',
        booking_date: date,
        status: 'confirmed',
        total_price: itemPrice,
        total_duration_minutes: empServiceData.duration_minutes,
        notes: 'Booked via website chat',
        items: [{
            id: crypto.randomBytes(8).toString('hex'),
            service_id,
            service_name: serviceData.name || { uz: '', ru: '' },
            employee_id: selectedEmp.id,
            employee_name: empName,
            start_time: startStr,
            end_time: endStr,
            original_price: empServiceData.price,
            price: itemPrice,
            ...(discountApplied && { discount_applied: discountApplied }),
            duration_minutes: empServiceData.duration_minutes,
            status: 'pending',
            order_index: 0,
        }],
        created_at: now,
        updated_at: now,
    };

    await db.collection('bookings').doc(bookingId).set(bookingPayload);

    return {
        success: true,
        booking_id: bookingId,
        service_name_uz: serviceData.name?.uz || '',
        service_name_ru: serviceData.name?.ru || '',
        employee_name: empName,
        date,
        time: secsToHHMM(start_time),
        end_time: secsToHHMM(slotEnd),
        price: itemPrice,
        original_price: empServiceData.price,
        duration_minutes: empServiceData.duration_minutes,
    };
}

// ─── Tool dispatcher ───

async function executeTool(name, args, businessId, session) {
    switch (name) {
        case 'get_services': return execGetServices(businessId);
        case 'get_available_dates': return execGetAvailableDates(businessId, args.service_id);
        case 'get_available_slots': return execGetAvailableSlots(businessId, args.date, args.service_id);
        case 'send_verification_code': return execSendOtp(args.phone_number, session);
        case 'verify_code': return execVerifyOtp(args.code, session);
        case 'register_user': return execRegisterUser(args.first_name, session);
        case 'create_booking': return execCreateBooking(businessId, session, args);
        default: return { error: `Unknown tool: ${name}` };
    }
}

// ─── System prompt builder ───

function buildChatSystemPrompt(businessData, businessId, session) {
    const tenantUrl = businessData.tenant_url || '';
    const bookingLink = tenantUrl ? `https://${tenantUrl}` : '';
    const isSolo = businessData.is_solo === true;
    const voice = isSolo ? '"I", "men"' : '"we", "biz", "my"';

    const uNow = uzbekNow();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const nowStr = `${days[uNow.getDay()]}, ${uNow.toISOString().split('T')[0]} ${secsToHHMM(uNow.getHours() * 3600 + uNow.getMinutes() * 60)}`;

    const authStatus = session.user_id
        ? `User is authenticated as "${session.first_name}" (user_id: ${session.user_id}).`
        : 'User is NOT authenticated. Authentication (phone + OTP) is required before booking.';

    return `You are a helpful booking assistant on the website of "${businessData.business_name || 'the business'}".
Voice: ${voice}. Tone: warm, helpful, concise. Not a bot.
Today: ${nowStr} (Tashkent, UTC+5)

Business: ${businessData.business_name || ''}
${businessData.bio || ''}
Phone: ${businessData.business_phone_number || 'N/A'}
${bookingLink ? `Website: ${bookingLink}` : ''}

AUTH STATUS: ${authStatus}

YOUR ROLE:
- Answer questions about services, prices, working hours, location.
- Help users book appointments through conversation.
- The user is ALREADY on the business website — never tell them to "visit the website".

BOOKING FLOW:
1. When user wants to book: call get_services to show options.
2. After they pick a service: call get_available_dates to show open days.
3. After they pick a date: call get_available_slots for time options.
4. After they pick a time: check auth status.
   - If NOT authenticated: ask for phone number, then call send_verification_code.
   - After OTP sent: ask user for the code, then call verify_code.
   - If verify_code returns needs_registration=true: ask for their first name, then call register_user.
5. Once authenticated: call create_booking with date, start_time, service_id.

RESPONSE FORMAT:
Always respond in valid JSON:
{
  "message": "your text to the user",
  "buttons": [{"label": "Button text", "value": "what to send when clicked"}],
  "input_type": null
}

BUTTON RULES:
- Include buttons ONLY when presenting specific choices (services, dates, times).
- CRITICAL: "value" MUST ALWAYS equal "label" exactly. Never use IDs, raw dates, or numbers as value. The value is shown as the user's chat message.
- For services: label = service name only, NO price (e.g. {"label": "Soch olish", "value": "Soch olish"}). Mention the price only AFTER the user selects.
- For dates: label = "day_name, date" (e.g. {"label": "Dushanba, 2026-03-12", "value": "Dushanba, 2026-03-12"}).
- For time slots: show up to 12 slots (e.g. {"label": "14:00", "value": "14:00"}).
- NEVER include buttons when asking for free-form input (phone, name, OTP).
- Keep labels short.

INPUT_TYPE:
- Set to "phone" when asking for phone number.
- Set to "otp" when asking for verification code.
- Set to "name" when asking for first name.
- Set to null for all other messages (including when showing buttons).

LANGUAGE RULES:
- Match the user's language (Uzbek/Russian).
- Match script: Cyrillic Uzbek → Cyrillic reply, Latin → Latin.
- Keep replies to 1-3 sentences. Be concise.
- Use 0-1 emoji per message.`;
}

// ─── Main function ───

/**
 * Generate an AI reply for a web chat message.
 * Runs OpenAI function-calling loop, executes tools, returns structured response.
 *
 * @param {string} businessId
 * @param {import('@google-cloud/firestore').DocumentReference} conversationRef
 * @param {object} conversationData - current conversation doc data
 * @param {string} userMessageText
 * @returns {Promise<{message: string, buttons: Array, input_type: string|null}>}
 */
export async function getChatAiReply(businessId, conversationRef, conversationData, userMessageText) {
    if (!openai) return { message: 'Chat is currently unavailable.', buttons: [], input_type: null };

    // Load business data
    const businessDoc = await db.collection('businesses').doc(businessId).get();
    if (!businessDoc.exists) return { message: 'Business not found.', buttons: [], input_type: null };
    const businessData = businessDoc.data();

    // Load/init session
    const session = conversationData.session || {};

    // Load conversation history (last 30 messages)
    const historySnap = await conversationRef.collection('messages')
        .orderBy('created_at', 'desc').limit(30).get();
    const history = historySnap.docs.reverse().map(doc => {
        const d = doc.data();
        if (d.sender_type === 'user') return { role: 'user', content: d.text };
        // For AI messages, include the raw text (might be JSON)
        return { role: 'assistant', content: d.text };
    });

    const systemPrompt = buildChatSystemPrompt(businessData, businessId, session);

    // Build messages for OpenAI
    let messages = [
        { role: 'system', content: systemPrompt },
        ...history,
    ];

    // Run tool-calling loop (max 6 iterations)
    let lastToolResults = [];
    for (let i = 0; i < 6; i++) {
        const response = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            temperature: 0.7,
            max_tokens: 500,
            messages,
            tools: TOOLS,
            response_format: { type: 'json_object' },
        });

        const choice = response.choices[0];

        if (choice.finish_reason === 'tool_calls' || choice.message.tool_calls?.length) {
            // Execute tool calls
            messages.push(choice.message);
            lastToolResults = [];

            for (const tc of choice.message.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch { }
                console.log(`Chat AI tool call: ${tc.function.name}(${JSON.stringify(args)})`);

                const result = await executeTool(tc.function.name, args, businessId, session);
                const resultStr = JSON.stringify(result);
                console.log(`Chat AI tool result: ${resultStr.slice(0, 200)}`);

                messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
                lastToolResults.push({ name: tc.function.name, args, result });
            }
            continue;
        }

        // Final text response
        const content = choice.message.content || '';
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            parsed = { message: content, buttons: [], input_type: null };
        }

        // Save updated session
        await conversationRef.update({ session });

        return {
            message: parsed.message || content,
            buttons: Array.isArray(parsed.buttons) ? parsed.buttons : [],
            input_type: parsed.input_type || null,
        };
    }

    // Fallback if loop exhausted
    await conversationRef.update({ session });
    return { message: 'Please try again.', buttons: [], input_type: null };
}
