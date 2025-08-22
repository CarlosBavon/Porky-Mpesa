const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mpesa credentials
const MPESA_CONFIG = {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE,
    passKey: process.env.MPESA_PASSKEY,
    callbackURL: process.env.MPESA_CALLBACK_URL,
    environment: process.env.MPESA_ENVIRONMENT
};

// Generate access token
const generateAccessToken = async () => {
    try {
        const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
        
        const response = await axios.get(
            MPESA_CONFIG.environment === 'production' 
                ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
                : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            {
                headers: {
                    Authorization: `Basic ${auth}`
                }
            }
        );

        return response.data.access_token;
    } catch (error) {
        console.error('Error generating access token:', error.response?.data || error.message);
        throw error;
    }
};

// Generate timestamp
const generateTimestamp = () => {
    const date = new Date();
    return (
        date.getFullYear() +
        ('0' + (date.getMonth() + 1)).slice(-2) +
        ('0' + date.getDate()).slice(-2) +
        ('0' + date.getHours()).slice(-2) +
        ('0' + date.getMinutes()).slice(-2) +
        ('0' + date.getSeconds()).slice(-2)
    );
};

// Generate password
const generatePassword = () => {
    const timestamp = generateTimestamp();
    const password = Buffer.from(
        `${MPESA_CONFIG.businessShortCode}${MPESA_CONFIG.passKey}${timestamp}`
    ).toString('base64');
    
    return { password, timestamp };
};

// STK Push endpoint
app.post('/api/mpesa/stkpush', async (req, res) => {
    try {
        const { phoneNumber, amount, accountReference, description } = req.body;

        if (!phoneNumber || !amount) {
            return res.status(400).json({
                error: 'Phone number and amount are required'
            });
        }

        // Format phone number (2547...)
        const formattedPhone = phoneNumber.startsWith('0') 
            ? `254${phoneNumber.slice(1)}` 
            : phoneNumber.startsWith('+254')
            ? phoneNumber.slice(1)
            : phoneNumber;

        const accessToken = await generateAccessToken();
        const { password, timestamp } = generatePassword();

        const stkPushPayload = {
            BusinessShortCode: MPESA_CONFIG.businessShortCode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: formattedPhone,
            PartyB: MPESA_CONFIG.businessShortCode,
            PhoneNumber: formattedPhone,
            CallBackURL: MPESA_CONFIG.callbackURL,
            AccountReference: accountReference || "Food Order",
            TransactionDesc: description || "Payment for food order"
        };

        const response = await axios.post(
            MPESA_CONFIG.environment === 'production'
                ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
                : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkPushPayload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json({
            success: true,
            message: 'STK Push initiated successfully',
            data: response.data,
            checkoutRequestID: response.data.CheckoutRequestID
        });

    } catch (error) {
        console.error('STK Push error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to initiate STK Push',
            details: error.response?.data || error.message
        });
    }
});

// Callback endpoint (for Mpesa to send payment confirmation)
app.post('/api/mpesa/callback', (req, res) => {
    try {
        const callbackData = req.body;
        console.log('Mpesa Callback Received:', JSON.stringify(callbackData, null, 2));

        // Process the callback data
        if (callbackData.Body.stkCallback && callbackData.Body.stkCallback.ResultCode === 0) {
            // Payment was successful
            const result = callbackData.Body.stkCallback;
            const metadata = result.CallbackMetadata?.Item || [];
            
            const paymentData = {
                amount: metadata.find(item => item.Name === 'Amount')?.Value,
                mpesaReceiptNumber: metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value,
                phoneNumber: metadata.find(item => item.Name === 'PhoneNumber')?.Value,
                transactionDate: metadata.find(item => item.Name === 'TransactionDate')?.Value,
                accountReference: result.MerchantRequestID
            };

            console.log('Payment successful:', paymentData);
            
            // Here you would update your database with the payment confirmation
            // Save order with payment status confirmed

        } else {
            // Payment failed
            console.log('Payment failed:', callbackData.Body.stkCallback?.ResultDesc);
        }

        res.status(200).send('Callback received successfully');

    } catch (error) {
        console.error('Callback processing error:', error);
        res.status(500).send('Error processing callback');
    }
});

// Order endpoint (to save order details)
app.post('/api/orders', async (req, res) => {
    try {
        const { 
            customerInfo, 
            cartItems, 
            total, 
            deliveryAddress, 
            paymentMethod 
        } = req.body;

        // Save order to database (you'll need to implement your database logic)
        const order = {
            orderId: `ORD-${Date.now()}`,
            customerInfo,
            items: cartItems,
            total,
            deliveryAddress,
            paymentMethod,
            status: paymentMethod === 'Mpesa' ? 'pending_payment' : 'pending',
            createdAt: new Date()
        };

        // Save to database (pseudo-code)
        // await db.collection('orders').insertOne(order);

        console.log('Order created:', order);

        res.json({
            success: true,
            orderId: order.orderId,
            message: 'Order created successfully'
        });

    } catch (error) {
        console.error('Order creation error:', error);
        res.status(500).json({
            error: 'Failed to create order'
        });
    }
});

// Check payment status
app.get('/api/payment/status/:checkoutRequestID', async (req, res) => {
    try {
        const { checkoutRequestID } = req.params;
        const accessToken = await generateAccessToken();

        const response = await axios.post(
            MPESA_CONFIG.environment === 'production'
                ? 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query'
                : 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: MPESA_CONFIG.businessShortCode,
                Password: generatePassword().password,
                Timestamp: generateTimestamp(),
                CheckoutRequestID: checkoutRequestID
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.json(response.data);

    } catch (error) {
        console.error('Payment status check error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to check payment status'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});