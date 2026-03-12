import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db/db.js';
import { sendOtpSms } from './eskiz.js';
import { generateTokenPair } from './jwt.js';
import { resolveDiscount } from './discountResolver.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

// ─── Structured output schema ───

const ChatResponseSchema = z.object({
    message: z.string().describe('Your reply text to the user'),
    buttons: z.array(z.object({
        label: z.string().describe('Button label shown to user'),
        value: z.string().describe('Value sent when button clicked — must equal label'),
    })).describe('Quick reply buttons. Empty array if no choices needed.'),
    input_type: z.enum(['phone', 'otp', 'name']).nullable().describe('Set to phone/otp/name when asking for that input, null otherwise'),
});
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = { uz: ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'], ru: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'] };
const MONTH_LABELS = { uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'], ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'] };

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
        name: 'get_services',
        description: 'Get list of available services with prices and durations. Call ONLY when: (1) user asks "what services do you have?", (2) you need to look up a service ID for a service the user mentioned by name, or (3) user is unsure what they want. Do NOT show service buttons if user already told you what they want — just use this to find the service_id internally, then proceed to dates.',
        parameters: { type: 'object', properties: {} },
    },
    {
        type: 'function',
        name: 'get_available_dates',
        description: 'Get up to 3 nearest available dates for booking. Returns only days with free slots, with human-friendly labels (Bugun, Ertaga, 14-mart). Use label_uz/label_ru for buttons.',
        parameters: {
            type: 'object',
            properties: {
                service_id: { type: 'string', description: 'Service ID to check availability for' },
            },
            required: ['service_id'],
        },
    },
    {
        type: 'function',
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
    {
        type: 'function',
        name: 'send_verification_code',
        description: 'Send SMS verification code to phone number. ONLY call this AFTER the user has explicitly typed their phone number in the chat. NEVER call this with a made-up or guessed number. You MUST first ask the user for their phone number and wait for their reply.',
        parameters: {
            type: 'object',
            properties: {
                phone_number: { type: 'string', description: 'Phone number like +998901234567 — must come from user input, never guess' },
            },
            required: ['phone_number'],
        },
    },
    {
        type: 'function',
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
    {
        type: 'function',
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
    {
        type: 'function',
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
    const businessData = businessDoc.data();
    const wh = businessData.working_hours || {};
    const today = uzbekToday();
    const tomorrowDate = new Date(uzbekNow());
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

    // Collect open days
    const openDates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(uzbekNow());
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const dayName = DAY_NAMES[d.getDay()];
        const hours = wh[dayName];
        if (!hours?.is_open) continue;
        openDates.push({ d, dateStr, hours });
        if (openDates.length >= 3) break;
    }

    // Check each date has available slots
    const dates = [];
    for (const { d, dateStr, hours } of openDates) {
        const slotsResult = await execGetAvailableSlots(businessId, dateStr, serviceId);
        if (!slotsResult.slots || slotsResult.slots.length === 0) continue;

        let label_uz, label_ru;
        if (dateStr === today) {
            label_uz = 'Bugun';
            label_ru = 'Сегодня';
        } else if (dateStr === tomorrowStr) {
            label_uz = 'Ertaga';
            label_ru = 'Завтра';
        } else {
            label_uz = `${d.getDate()}-${MONTH_LABELS.uz[d.getMonth()]} (${DAY_LABELS.uz[d.getDay()]})`;
            label_ru = `${d.getDate()} ${MONTH_LABELS.ru[d.getMonth()]} (${DAY_LABELS.ru[d.getDay()]})`;
        }

        dates.push({
            date: dateStr,
            label_uz,
            label_ru,
            hours: `${secsToHHMM(hours.start)} - ${secsToHHMM(hours.end)}`,
            available_slots: slotsResult.total,
        });
    }

    if (dates.length === 0) return { dates: [], note: 'Yaqin kunlarda bo\'sh joy yo\'q.' };
    return { dates };
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

function buildWorkingHoursLine(working_hours) {
    const wh = working_hours || {};
    return DAY_NAMES.map((day, i) => {
        const h = wh[day];
        if (!h || !h.is_open) return `${DAY_LABELS.uz[i]}: yopiq`;
        return `${DAY_LABELS.uz[i]}: ${secsToHHMM(h.start)}-${secsToHHMM(h.end)}`;
    }).join(', ');
}

function buildChatSystemPrompt(businessData, businessId, session) {
    const tenantUrl = businessData.tenant_url || '';
    const bookingLink = tenantUrl ? `https://${tenantUrl}` : '';
    const isSolo = businessData.is_solo === true;

    const uNow = uzbekNow();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const nowStr = `${days[uNow.getDay()]}, ${uNow.toISOString().split('T')[0]} ${secsToHHMM(uNow.getHours() * 3600 + uNow.getMinutes() * 60)}`;

    const authStatus = session.user_id
        ? `Foydalanuvchi autentifikatsiya qilingan: "${session.first_name}" (user_id: ${session.user_id}).`
        : 'Foydalanuvchi autentifikatsiya qilinmagan. Booking uchun telefon + OTP talab qilinadi.';

    const workingHoursLine = buildWorkingHoursLine(businessData.working_hours);
    const addressLine = businessData.location?.display_address || businessData.location?.street_name || '';
    const paymentLine = businessData.payment_methods || 'naqd pul yoki karta';
    const phone = businessData.business_phone_number || '';

    return `Sen "${businessData.business_name || ''}" ning saytidagi yordamchisan. Robot emas — xuddi telefondan javob beradigan qabulxona xodimi kabi gapir.

Biznes: ${businessData.business_name || ''}
${businessData.bio ? `Haqida: ${businessData.bio}` : ''}
Telefon: ${phone}${bookingLink ? `\nSayt: ${bookingLink}` : ''}
${isSolo ? '"Men" deb gapir.' : '"Biz" deb gapir.'}
Ish vaqti: ${workingHoursLine}${addressLine ? `\nManzil: ${addressLine}` : ''}
To'lov: ${paymentLine}
Holat: ${authStatus}
Bugun: ${nowStr} (UTC+5)

═══ QANDAY GAPLASHISH KERAK ═══

Qisqa, tabiiy, samimiy gapir. Har bir javobda FAQAT 1 ta savol so'ra.
Mijoz qaysi tilda yozsa, shu tilda javob ber. Kirill → Kirill, Lotin → Lotin. 0-1 emoji.

YAXSHI MISOLLAR:

Salomlashish:
- "salom" → "Salom! 👋 Sizga qanday yordam bera olaman?"
- "assalomu alaykum" → "Va alaykum assalom! Qanday xizmat kerak?"
- "привет" → "Привет! Чем могу помочь?"
- "hi" / "hello" → "Hi there! What would you like to book today?"

Booking:
- "soch oldirmoqchiman" → "Albatta! Qaysi vaqt sizga qulay?"
- "bugunga yozilmoqchiman" → "Yaxshi! Qaysi vaqtga yozilmoqchisiz?"
- "I want to book a haircut" → "Sure! What time works best for you?"
- "haircut + beard today" → "Sure! What time would you like to come?"
- "5pm free?" → "Tekshirib ko'ray… ha, 17:00 bo'sh ekan."
- "bro haircut today" → "Sure! What time works for you?"

Narx:
- "narxi qancha?" → "Xizmat narxi [narx]. Yozib qo'yaymi?"
- "how much for haircut and beard?" → "Haircut + beard costs about [price]."

Tasdiqlash:
- "ok book it" → "Tayyor! Soat 16:30 da Aziz bilan kutamiz ✂️"
- "ok" → "Ajoyib! Yozuvingiz tasdiqlandi."

Xayrlashish:
- "rahmat" → "Arzimaydi! Yana kutib qolamiz 😊"
- "thanks" → "You're welcome! Hope to see you again soon 😊"
- "ok see you" → "Kutib qolamiz! Yaxshi kun! ✂️"

YOMON:
- ❌ "Xush kelibsiz! Sizga qanday yordam berishim mumkin?" — robot gapi
- ❌ "Quyidagi variantlardan birini tanlang" — forma, chat emas
- ❌ "Your request has been processed." — robot gapi
- ❌ "Sizning so'rovingiz qabul qilindi." — robot gapi

═══ SAVOLLARGA JAVOB ═══

- Ish vaqti → ish vaqti ma'lumotlaridan javob ber, keyin NUDGE (yengil)
- Narx → get_services chaqir, natijani tabiiy ayt, keyin NUDGE (kuchliroq)
- Manzil → manzil ma'lumotidan javob ber, keyin NUDGE (yengil). Agar manzil bo'sh bo'lsa → "${phone} ga qo'ng'iroq qilib so'rang"
- "Manzil va ish vaqti" → IKKISINI HAM ko'rsat: avval manzil (agar bor bo'lsa), keyin ish vaqti. NUDGE (yengil)
- To'lov → to'lov ma'lumotidan javob ber, keyin NUDGE (yengil)
- Walk-in → "Band qilib kelgan ma'qul", keyin NUDGE
- Bekor qilish → telefon raqamga (${phone}) yo'naltir, keyin NUDGE
- Kechikish ("kechikaman" / "I will be late") → "Mayli, kutib turamiz. Iloji boricha tezroq keling."
- Yozuvni o'zgartirish → "Mayli! Qaysi vaqtga o'zgartirmoqchisiz?" keyin NUDGE
- Tavsiya ("qanday soch turmagini tavsiya qilasiz?") → ustaga yo'naltir: "Ustamiz yuz shaklingizga qarab yaxshi variant tavsiya qiladi"
- Tushunmayotgan mijoz ("how does booking work?") → qisqa tushuntir, keyin NUDGE
- Salom/rahmat/xayr → qisqa tabiiy javob, NUDGE YO'Q
- Noma'lum savol → "${phone} ga qo'ng'iroq qiling" de, taxmin QILMA, NUDGE YO'Q (mavzusiz bo'lsa)
- Mavzusiz → xizmatga qaytarib yo'naltir

NUDGE (matn, button emas): "Yozdiraysizmi?" / "Band qilaylikmi?" / "Yozilmoqchimisiz?" / "Yozib qo'yaymi?" — har safar aylantirib turgin.

═══ BOOKING FLOW ═══

Tabiiy suhbat orqali booking qilishga olib bor:
1. Xizmat → get_services (agar noaniq), qaysi kunga so'ra
2. Kun → get_available_dates (max 3 kun qaytadi, faqat bo'sh joylar bor kunlar). Buttonlarda label_uz/label_ru ishlatib ko'rsat ("Bugun", "Ertaga", "14-mart (Juma)"). RAW sana (2026-03-12) ko'rsatMA.
3. Vaqt → get_available_slots, vaqtlarni ko'rsat
4. Mijoz vaqt tanlasa → TASDIQLASH bosqichiga o't (pastga qara)
5. Mijoz tasdiqlasa VA auth yo'q bo'lsa → telefon raqam SO'RA: "Telefon raqamingizni yuboring" (input_type: "phone", buttons: [])
6. Mijoz raqamini YOZGANDAN KEYIN → send_verification_code chaqir. HECH QACHON raqam taxmin qilma yoki o'ylab topma.
7. Kod → verify_code (input_type: "otp")
8. Yangi foydalanuvchi → ism so'ra (input_type: "name"), register_user
9. Hammasi tayyor → create_booking

MUHIM QOIDALAR:
- Har bir qadamda FAQAT BITTA narsa so'ra
- send_verification_code ni FAQAT mijoz o'zi raqamini yozganda chaqir
- Telefon raqamni HECH QACHON taxmin qilma — foydalanuvchi kiritishi KERAK
- 5-bosqichni TASHLAB o'tma — avval raqam so'ra, KEYIN kod yuborish

═══ TASDIQLASH ═══

Mijoz vaqt tanlagandan keyin, DARHOL quyidagi formatda xulosa ko'rsat:
message: "<Xizmat nomi>, <sana>, soat <HH:MM> — to'g'rimi?"
buttons: ["Ha, yozib qo'ying", "Vaqtni o'zgartiraman"] (yoki ruscha: ["Да, запишите", "Изменить время"])
input_type: null

MISOL: "Soch va soqol, 12 mart, soat 12:00 — to'g'rimi?" + buttons
BU BOSQICHNI TASHLAB O'TMA. "Shu vaqtga yozaymi?" deb so'rama — XULOSA + BUTTONS ko'rsat.

Tasdiqlash: tugma bosilsa YOKI "ha", "ok", "да", "хорошо", "yaxshi" yozilsa → keyingi bosqichga o't (auth tekshir).
Noaniq javob → qayta so'ra, shu tugmalarni ko'rsat.
HECH QACHON create_booking ni tasdiqlashdan oldin chaqirma.

═══ BUTTONS ═══

FAQAT 3 HOLAT:
1. Birinchi salomlashuvda: ["Yozilish", "Narxlar", "Manzil va ish vaqti"]
2. Xizmat/kun/vaqt tanlashda: tegishli ro'yxat
3. Tasdiqlash bosqichida: ["Ha, yozib qo'ying", "Vaqtni o'zgartiraman"]
BOSHQA BARCHA HOLLARDA: buttons: []
Narx/manzil/ish vaqti savollariga javob: buttons: []
Telefon/OTP/ism so'raganda: HECH QACHON button qo'yma
"value" DOIM "label" bilan bir xil bo'lsin.

═══ INPUT_TYPE ═══

- "phone" — telefon raqam so'raganda
- "otp" — tasdiqlash kodi so'raganda
- "name" — ism so'raganda
- null — boshqa barcha holatlar`;
}

// ─── Test exports (for unit testing only) ───
export { buildChatSystemPrompt as _buildChatSystemPrompt, buildWorkingHoursLine as _buildWorkingHoursLine };

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

    // Load conversation history (last 20 messages)
    const historySnap = await conversationRef.collection('messages')
        .orderBy('created_at', 'desc').limit(20).get();
    const history = historySnap.docs.reverse().map(doc => {
        const d = doc.data();
        if (d.sender_type === 'user') return { role: 'user', content: d.text };
        // For AI messages, pass clean text (strip any legacy raw JSON)
        let aiText = d.text;
        if (typeof aiText === 'string' && aiText.trim().startsWith('{')) {
            try {
                const p = JSON.parse(aiText);
                if (p.message) aiText = p.message;
            } catch { /* keep as-is */ }
        }
        return { role: 'assistant', content: aiText };
    });

    const systemPrompt = buildChatSystemPrompt(businessData, businessId, session);

    // Build input for Responses API
    let input = [
        { role: 'system', content: systemPrompt },
        ...history,
    ];

    // Run tool-calling loop (max 6 iterations)
    for (let i = 0; i < 6; i++) {
        const response = await openai.responses.parse({
            model: 'gpt-4.1-mini',
            temperature: 0.7,
            max_output_tokens: 500,
            input,
            tools: TOOLS,
            text: { format: zodTextFormat(ChatResponseSchema, 'chat_response') },
        });

        // Check for function/tool calls
        const functionCalls = response.output.filter(item => item.type === 'function_call');

        if (functionCalls.length > 0) {
            // Add AI output (function calls) to input for next iteration
            // Strip parsed_arguments added by responses.parse() — API rejects unknown fields
            input.push(...response.output.map(item => {
                if (item.type === 'function_call') {
                    const { id, type, call_id, name, arguments: args } = item;
                    return { id, type, call_id, name, arguments: args };
                }
                return item;
            }));

            for (const fc of functionCalls) {
                let args = {};
                try { args = JSON.parse(fc.arguments); } catch { }
                console.log(`Chat AI tool call: ${fc.name}(${JSON.stringify(args)})`);

                const result = await executeTool(fc.name, args, businessId, session);
                const resultStr = JSON.stringify(result);
                console.log(`Chat AI tool result: ${resultStr.slice(0, 200)}`);

                input.push({
                    type: 'function_call_output',
                    call_id: fc.call_id,
                    output: resultStr,
                });
            }
            continue;
        }

        // Structured text response — guaranteed valid by zodTextFormat
        await conversationRef.update({ session });

        if (response.output_parsed) {
            return {
                message: response.output_parsed.message,
                buttons: response.output_parsed.buttons || [],
                input_type: response.output_parsed.input_type || null,
            };
        }

        // Fallback: extract from raw text output if parse missed
        const textItem = response.output.find(item => item.type === 'message' || item.type === 'text');
        if (textItem) {
            try {
                const parsed = JSON.parse(typeof textItem.content === 'string' ? textItem.content : JSON.stringify(textItem.content));
                return {
                    message: parsed.message || '',
                    buttons: Array.isArray(parsed.buttons) ? parsed.buttons : [],
                    input_type: parsed.input_type || null,
                };
            } catch { /* fall through */ }
        }

        return { message: 'Iltimos, qayta yozing.', buttons: [], input_type: null };
    }

    // Fallback if loop exhausted
    await conversationRef.update({ session });
    return { message: 'Iltimos, qayta yozing.', buttons: [], input_type: null };
}
