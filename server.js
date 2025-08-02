const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// Configuración de variables de entorno
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_CONNECTIONS_PER_IP = 75;

// Inicialización de Express y Socket.IO
const app = express();
const server = http.createServer(app);

// 🚀 CONFIGURACIÓN OPTIMIZADA PARA RAILWAY
const isDevelopment = NODE_ENV === 'development';
const isProduction = NODE_ENV === 'production';

// Reducir logging en producción
const logger = {
  log: (...args) => {
    if (isDevelopment) console.log(...args);
  },
  error: (...args) => {
    console.error(...args); // Siempre mostrar errores
  },
  warn: (...args) => {
    if (isDevelopment) console.warn(...args);
  }
};

// CONFIGURACIÓN DE SEGURIDAD CRÍTICA
app.set('trust proxy', 1);

// 🔒 HELMET - Headers de seguridad con configuración moderna
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 🔒 CORS SEGURO - Configuración para apps móviles en tiendas
const allowedOrigins = [
  // Para apps móviles nativas (iOS/Android)
  'capacitor://localhost',
  'ionic://localhost',
  'file://',

  // Para apps móviles con protocolos personalizados de QuizBible
  'quizbible://',
  'com.quizbible.app://', // Ajusta esto según tu bundle ID en iOS/Android

  // Para tu dominio de producción en Railway
  'https://web-production-b4576.up.railway.app', // Ajusta esto a tu dominio en Railway

  // Para desarrollo (solo se usarán si NODE_ENV === 'development')
  ...(NODE_ENV === 'development' ? [
    'http://localhost:3000',
    'http://localhost:8100',
    'http://192.168.100.129:3000',
    'http://192.168.100.129:8100'
  ] : [])
];

const corsOptions = {
  origin: function (origin, callback) {
    // Permitir requests sin origin (apps móviles nativas)
    if (!origin) {
      console.log('✅ Request sin origin permitido (app móvil nativa)');
      return callback(null, true);
    }

    // En producción, ser estricto con los orígenes permitidos
    if (NODE_ENV === 'production') {
      if (allowedOrigins.includes(origin) ||
        origin.startsWith('quizbible://') ||
        origin.startsWith('com.quizbible.app://')) {
        return callback(null, true);
      }
    } else {
      // En desarrollo, ser más permisivo
      if (allowedOrigins.includes(origin) ||
        origin.includes('localhost') ||
        origin.includes('192.168.')) {
        return callback(null, true);
      }
    }

    callback(new Error('No permitido por CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// 🔒 CONFIGURACIÓN ESPECÍFICA PARA APPS MÓVILES
app.use((req, res, next) => {
  // Headers adicionales para apps móviles
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Manejar preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// 🔒 RATE LIMITING CONFIGURACIÓN MODERNA
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 150,
  message: { error: 'Demasiadas solicitudes desde esta IP, por favor intente más tarde' },
  standardHeaders: true, // Devuelve rate limit info en los headers `RateLimit-*`
  legacyHeaders: false, // Deshabilita los headers `X-RateLimit-*`
  keyGenerator: (req) => {
    // Usar X-Forwarded-For si está disponible, sino usar IP
    return req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  },
  skip: (req) => {
    return req.path === '/health' || req.path === '/ping';
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Demasiadas solicitudes',
      retryAfter: Math.ceil(generalLimiter.windowMs / 1000),
      message: 'Por favor, intente más tarde'
    });
  }
});

// Rate limit más estricto para creación de salas
const createRoomLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas creaciones de sala' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress
});

// Rate limit para unirse a salas
const joinRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos de unirse a salas' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress
});

// Aplicar rate limiting
app.use(generalLimiter);
app.use('/api/rooms/create', createRoomLimiter);
app.use('/api/rooms/join', joinRoomLimiter);

// 🔒 VALIDACIÓN DE DATOS
const validateUserData = (data) => {
  const { userId, userName, userEmail, userPhoto } = data;

  if (!userId || typeof userId !== 'string' || userId.length > 100) {
    throw new Error('ID de usuario inválido');
  }

  if (!userName || typeof userName !== 'string' || userName.length > 50) {
    throw new Error('Nombre de usuario inválido');
  }

  if (userEmail && (typeof userEmail !== 'string' || userEmail.length > 100)) {
    throw new Error('Email inválido');
  }

  if (userPhoto && (typeof userPhoto !== 'string' || userPhoto.length > 500)) {
    throw new Error('URL de foto inválida');
  }

  return true;
};

// 🔒 SANITIZACIÓN DE DATOS
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '') // Remover < y >
    .trim()
    .substring(0, 1000); // Limitar longitud
};

// middleware para compresion
app.use(compression());

// 🔒 LIMITE DE TAMAÑO DE JSON
app.use(express.json({ limit: '1mb' })); // Limitar tamaño de requests

// 🔒 TIMEOUT PARA REQUESTS
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// 🔧 CONFIGURACIÓN DE MEMORIA OPTIMIZADA PARA RAILWAY
if (isProduction) {
  // Solo en producción, monitorear memoria cada 30 minutos en lugar de 5
  setInterval(() => {
    const used = process.memoryUsage();
    const memoryUsedMB = Math.round(used.heapUsed / 1024 / 1024);

    // Solo loggear si la memoria supera un umbral
    if (memoryUsedMB > 400) { // Alertar si supera 400MB
      console.warn(`⚠️ Memoria alta: ${memoryUsedMB} MB`);
    }

    // Forzar garbage collection si la memoria es muy alta
    if (memoryUsedMB > 450 && global.gc) {
      global.gc();
      logger.log('🧹 Garbage collection forzado');
    }
  }, 1800000); // Cada 30 minutos en lugar de 5
}

// 🔧 LÍMITES PARA RAILWAY
const RAILWAY_LIMITS = {
  MAX_ROOMS: isProduction ? 50 : 10, // Máximo 50 salas en producción
  MAX_CONNECTIONS_PER_IP: isProduction ? 5 : 20, // Más restrictivo en producción
  CLEANUP_INTERVAL: isProduction ? 600000 : 300000, // 10 min en prod, 5 min en dev
  MEMORY_CLEANUP_THRESHOLD: 450 // MB
};



// 🔧 ALMACENAMIENTO OPTIMIZADO CON LÍMITES
const gameRooms = new Map();
const roomTimeouts = new Map();
const connectionCount = new Map();

// 🔧 FUNCIÓN DE LIMPIEZA OPTIMIZADA
const cleanupInactiveRooms = () => {
  const now = new Date();
  const inactiveThreshold = 10 * 60 * 1000; // 10 minutos
  let cleanedCount = 0;

  // Si hay demasiadas salas, ser más agresivo con la limpieza
  const isOverLimit = gameRooms.size > RAILWAY_LIMITS.MAX_ROOMS;
  const aggressiveThreshold = isOverLimit ? 5 * 60 * 1000 : inactiveThreshold; // 5 min si hay muchas

  for (const [roomId, room] of gameRooms.entries()) {
    const roomAge = now - new Date(room.createdAt).getTime();

    const shouldClean = roomAge > aggressiveThreshold ||
      (room.status === 'finished' && roomAge > 3 * 60 * 1000) || // 3 min para terminadas
      (room.status === 'waiting' && roomAge > aggressiveThreshold);

    if (shouldClean) {
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }
      gameRooms.delete(roomId);
      cleanedCount++;

      if (isDevelopment) {
        logger.log(`🧹 Sala limpiada: ${roomId} (edad: ${Math.round(roomAge / 60000)} min)`);
      }
    }
  }

  if (cleanedCount > 0) {
    logger.log(`🧹 Limpiadas ${cleanedCount} salas. Total restantes: ${gameRooms.size}`);
  }

  // Limpiar conexiones huérfanas
  if (connectionCount.size > 100) {
    connectionCount.clear();
    logger.log('🧹 Limpieza de connectionCount');
  }
};

// Ejecutar limpieza según el entorno
setInterval(cleanupInactiveRooms, RAILWAY_LIMITS.CLEANUP_INTERVAL);

// 🔧 MIDDLEWARE DE LÍMITES PARA RAILWAY
app.use((req, res, next) => {
  const clientIp = req.headers['x-forwarded-for'] || req.ip;
  const currentConnections = connectionCount.get(clientIp) || 0;

  if (currentConnections >= RAILWAY_LIMITS.MAX_CONNECTIONS_PER_IP) {
    return res.status(429).json({
      error: 'Demasiadas conexiones activas',
      limit: RAILWAY_LIMITS.MAX_CONNECTIONS_PER_IP
    });
  }

  next();
});

// 🔒 SOCKET.IO CON SEGURIDAD MEJORADA PARA APPS MÓVILES
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: isProduction ? 30000 : 45000, // Más agresivo en producción
  pingInterval: isProduction ? 15000 : 20000,
  transports: ['websocket', 'polling'],
  allowEIO3: false,
  maxHttpBufferSize: isProduction ? 500000 : 1000000, // Reducir buffer en producción
  allowRequest: (req, callback) => {
    // Verificar límites antes de permitir conexión
    if (gameRooms.size >= RAILWAY_LIMITS.MAX_ROOMS) {
      logger.warn(`🚫 Servidor lleno: ${gameRooms.size} salas`);
      return callback('Servidor temporalmente lleno', false);
    }

    const origin = req.headers.origin;
    const userAgent = req.headers['user-agent'];

    // Bloquear user agents sospechosos
    if (userAgent && (
      userAgent.includes('bot') ||
      userAgent.includes('crawler') ||
      userAgent.includes('scraper')
    )) {
      console.log(`🚫 User agent bloqueado: ${userAgent}`);
      return callback(null, false);
    }

    // Permitir conexiones de apps móviles nativas
    if (!origin) {
      console.log('✅ Socket.IO: Request sin origin permitido (app móvil nativa)');
      return callback(null, true);
    }

    // Usar la misma lógica de CORS que para HTTP
    corsOptions.origin(origin, (err, allowed) => {
      if (err || !allowed) {
        callback(null, false);
      } else {
        callback(null, true);
      }
    });
  }
});

// 🔒 MIDDLEWARE DE SEGURIDAD PARA SOCKETS
io.use((socket, next) => {
  const clientIp = socket.handshake.address;
  const userAgent = socket.handshake.headers['user-agent'];

  // Validar user agent
  if (!userAgent || userAgent.length < 10) {
    return next(new Error('User agent inválido'));
  }

  // Rate limiting para sockets
  const currentCount = connectionCount.get(clientIp) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    return next(new Error('Demasiadas conexiones desde esta IP'));
  }

  connectionCount.set(clientIp, currentCount + 1);
  socket.on('disconnect', () => {
    const newCount = connectionCount.get(clientIp) - 1;
    if (newCount <= 0) {
      connectionCount.delete(clientIp);
    } else {
      connectionCount.set(clientIp, newCount);
    }
  });

  next();
});

// Ruta principal
app.get('/', (req, res) => {
  res.json({ message: 'Servidor funcionandoooo0' });
});

// Ruta de prueba
app.get('/test', (req, res) => {
  res.json({
    success: true,
    data: 'Todo bien'
  });
});

// Ruta para verificar si una sala existe
app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = gameRooms.get(roomId);


  if (room) {
    res.json({
      exists: true,
      room: {
        id: roomId,
        players: room.players,
        playersData: room.playersData,
        status: room.status,
        creator: room.creator,
        gameSettings: room.gameSettings
      }
    });
  } else {
    res.json({ exists: false });
  }
});

// Ruta para obtener todas las salas (para debugging)
app.get('/rooms', (req, res) => {
  const rooms = Array.from(gameRooms.entries()).map(([id, room]) => ({
    id,
    players: room.players,
    status: room.status,
    creator: room.creator,
    createdAt: room.createdAt,
    age: Math.round((new Date() - new Date(room.createdAt)) / 60000) // edad en minutos
  }));
  res.json({
    rooms,
    totalRooms: rooms.length,
    activeRooms: rooms.filter(r => r.status === 'playing').length,
    waitingRooms: rooms.filter(r => r.status === 'waiting').length,
    finishedRooms: rooms.filter(r => r.status === 'finished').length
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {

  // Crear nueva sala de juego
  socket.on('createRoom', (data) => {
    try {
      // Validar datos
      validateUserData(data);

      // Sanitizar datos
      const sanitizedData = {
        userId: sanitizeInput(data.userId),
        userName: sanitizeInput(data.userName),
        userEmail: sanitizeInput(data.userEmail),
        userPhoto: sanitizeInput(data.userPhoto)
      };

      // Generar código de sala
      const generateRoomCode = () => {
        const chars = '0123456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
          result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
      };

      let roomId = generateRoomCode();
      let attempts = 0;

      // Verificar que el código no exista para evitar colisiones
      while (gameRooms.has(roomId) && attempts < 10) {
        roomId = generateRoomCode();
        attempts++;
      }

      if (attempts >= 10) {
        socket.emit('roomCreationError', { message: 'No se pudo generar un código único' });
        return;
      }

      // Crear la sala sin preguntas inicialmente
      const roomData = {
        id: roomId,
        creator: {
          uid: sanitizedData.userId,
          name: sanitizedData.userName
        },
        players: [sanitizedData.userId],
        playersData: {
          [sanitizedData.userId]: {
            id: sanitizedData.userId,
            name: sanitizedData.userName,
            socketId: null, // se actualisara cuando se conecte
            ready: false,
            score: 0,
            connected: true,
            photo: sanitizedData.userPhoto
          }
        },
        status: 'waiting',
        createdAt: new Date(),
        maxPlayers: 2,
        gameSettings: {
          questionsCount: 10, // Configuración por defecto
          timePerQuestion: 18,
        },
        currentQuestion: 0,
        gameStarted: false,
        questions: [], // Las preguntas se obtendrán cuando ambos estén listos
        questionAnswers: {},
        scores: {},
        pendingQuestions: {}, // Para almacenar preguntas de cada jugador
        correctAnswers: {} // Nuevo objeto para rastrear respuestas correctas por jugador
      };

      gameRooms.set(roomId, roomData);

      // Unirse a la sala
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = sanitizedData.userId;

      // Notificar al creador
      socket.emit('roomCreated', {
        roomId,
        room: roomData
      });
    } catch (error) {
      socket.emit('error', { message: 'Datos inválidos' });
      return;
    }
  });

  // Unirse a una sala de juego
  socket.on('joinRoom', (data) => {
    const { roomId, userId, userName, userEmail, userPhoto } = data;

    const room = gameRooms.get(roomId);

    if (!room) {
      socket.emit('joinRoomError', { message: 'La sala no existe ' });
      return;
    }


    // Verificar si es una reconexión
    const isReconnection = room.players.includes(userId);

    if (isReconnection) {

      // Cancelar timeout de eliminación si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      // Actualizar datos del jugador para reconexión
      room.playersData[userId] = {
        ...room.playersData[userId],
        socketId: socket.id,
        connected: true,
        disconnectedAt: null
      };

      // Asegurarse de que el socket esté en la sala
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = userId;


      // Notificar reconexión
      io.to(roomId).emit('playerReconnected', {
        roomId,
        reconnectedPlayerId: userId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings
      });

      // Si la sala ya está jugando, enviar estado del juego
      if (room.status === 'playing') {

        // Preparar preguntas para enviar al cliente (sin respuestas correctas)
        const questionsForClient = room.questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          answers: q.answers,
          bibleReference: q.bibleReference,
          index: q.index
          // NO enviamos correctAnswer al cliente 
        }));

        // Enviar estado actual del juego solo al jugador reconectado
        socket.emit('gameInProgress', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          scores: room.scores,
          questions: questionsForClient,
          currentQuestion: room.currentQuestion
        });
      }

      return;
    }

    // Validaciones para nuevos jugadores
    if (room.status !== 'waiting') {
      socket.emit('joinRoomError', { message: 'Esta sala ya no está disponible' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('joinRoomError', { message: 'La sala está llena' });
      return;
    }

    // Unirse a la sala de Socket.IO
    socket.join(roomId);

    // Agregar jugador a la sala
    room.players.push(userId);
    room.playersData[userId] = {
      id: userId,
      name: userName,
      email: userEmail,
      socketId: socket.id,
      ready: false,
      score: 0,
      connected: true,
      photo: userPhoto
    };

    // Guardar referencia de la sala en el socket
    socket.roomId = roomId;
    socket.userId = userId;


    // Notificar a todos en la sala
    io.to(roomId).emit('playerJoined', {
      roomId,
      players: room.players,
      playersData: room.playersData,
      creator: room.creator,
      gameSettings: room.gameSettings
    });
  });



  // Marcar usuario como listo
  socket.on('playerReady', (data) => {
    const { roomId, userId, questions, questionsId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.playersData[userId]) {
      room.playersData[userId].ready = true;

      // Almacenar las preguntas del jugador si las proporciona
      if (questions && questions.length > 0) {
        room.pendingQuestions[userId] = questions;
      }

      // Almacenar los IDs de las preguntas del jugador
      if (questionsId && questionsId.length > 0) {
        room.playersData[userId].userQuestionIds = questionsId;
      }

      // Verificar si todos están listos
      const allReady = room.players.every(playerId =>
        room.playersData[playerId]?.ready
      );

      if (allReady && room.players.length === 2) {
        // Si la sala está en estado 'finished', hacer reset antes de iniciar
        if (room.status === 'finished') {

          // Preservar los scores finales antes de resetear
          const finalScores = { ...room.scores };
          const playersData = { ...room.playersData };
          const questionsCount = room.questions.length;

          // Resetear el estado del juego
          room.status = 'waiting';
          room.questionAnswers = {};
          room.scores = {};
          room.currentQuestion = 0;
          room.questions = [];

          // LIMPIAR LAS PREGUNTAS PENDIENTES PARA FORZAR NUEVAS PREGUNTAS
          room.pendingQuestions = {};
          room.correctAnswers = {}; // Limpiar respuestas correctas

          // Resetear el estado "ready" de todos los jugadores
          Object.keys(room.playersData).forEach(playerId => {
            if (room.playersData[playerId]) {
              room.playersData[playerId].ready = false;
              // También limpiar los userQuestionIds para forzar nuevas preguntas
              room.playersData[playerId].userQuestionIds = [];
            }
          });

          // Notificar a todos los jugadores que el juego se reinició
          io.to(roomId).emit('gameStateReset', {

            roomId,
            message: 'Juego reiniciado para revancha',
            players: room.players,
            playersData: playersData,
            creator: room.creator,
            gameSettings: room.gameSettings,
            questionsCount: questionsCount,
            //showResults: false,
            finalScores: finalScores,
            rematchInitiator: userId
          });

          // Continuar con el proceso normal de marcar como listo
          return;
        }

        // Proceso normal para iniciar juego
        room.status = 'playing';
        room.players.forEach(playerId => {
          const player = room.playersData[playerId];
        });

        // Combinar preguntas de ambos jugadores
        const allQuestions = [];

        // Agregar preguntas del creador primero (si tiene)
        if (room.pendingQuestions[room.creator.uid]) {
          allQuestions.push(...room.pendingQuestions[room.creator.uid]);
        }

        // Agregar preguntas del segundo jugador
        const secondPlayerId = room.players.find(id => id !== room.creator.uid);
        if (secondPlayerId && room.pendingQuestions[secondPlayerId]) {
          allQuestions.push(...room.pendingQuestions[secondPlayerId]);
        }

        // Si no hay preguntas de los jugadores, usar preguntas por defecto
        if (allQuestions.length === 0) {
          io.to(roomId).emit('gameReadyError', {
            message: 'No se pudieron obtener preguntas para el juego'
          });
          return;
        }

        // Mezclar las preguntas para que no sean predecibles
        const shuffledQuestions = allQuestions.sort(() => Math.random() - 0.5);

        // Tomar solo las primeras 10 preguntas
        room.questions = shuffledQuestions.slice(0, 10);
        room.gameSettings.questionsCount = room.questions.length;


        // Preparar preguntas para enviar al cliente (sin respuestas correctas)
        const questionsForClient = room.questions.map(q => ({
          questionId: q.questionId,
          question: q.question,
          answers: q.answers,
          bibleReference: q.bibleReference,
          index: q.index
          // NO enviamos correctAnswer al cliente
        }));

        // Preparar userQuestionIds para cada jugador
        const userQuestionIdsForPlayers = {};
        room.players.forEach(playerId => {
          if (room.playersData[playerId]?.userQuestionIds) {
            userQuestionIdsForPlayers[playerId] = room.playersData[playerId].userQuestionIds;
          } else {
            userQuestionIdsForPlayers[playerId] = [];
          }
        });

        // Notificar a todos que el juego puede comenzar
        io.to(roomId).emit('gameReady', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          scores: room.scores,
          questions: questionsForClient,
          userQuestionIds: userQuestionIdsForPlayers // Enviar los IDs de preguntas de cada jugador
        });
      } else {
        // console.log(`⏳ No todos están listos aún en sala ${roomId}`);
        room.players.forEach(playerId => {
          const player = room.playersData[playerId];
        });

        // Notificar actualización del estado
        io.to(roomId).emit('playerStatusUpdated', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings
        });
      }
    } else {
      console.log(`❌ No se pudo marcar como listo: sala o usuario no encontrado`);
    }
  });

  // Solicitar estado actual de la sala
  socket.on('requestRoomState', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);


    if (!room) {
      //socket.emit('roomStateError', { message: 'La sala no existe' });
      return;
    }


    if (room.status === 'waiting') {
      // Si la sala está esperando, enviar estado de espera
      socket.emit('roomWaiting', {
        roomId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings
      });
    } else if (room.status === 'playing') {

      // Preparar preguntas para enviar al cliente (sin respuestas correctas)
      const questionsForClient = room.questions.map(q => ({
        questionId: q.questionId,
        question: q.question,
        answers: q.answers,
        bibleReference: q.bibleReference,
        index: q.index
        // NO enviamos correctAnswer al cliente
      }));

      // Preparar userQuestionIds para cada jugador
      const userQuestionIdsForPlayers = {};
      room.players.forEach(playerId => {
        if (room.playersData[playerId]?.userQuestionIds) {
          userQuestionIdsForPlayers[playerId] = room.playersData[playerId].userQuestionIds;
        } else {
          userQuestionIdsForPlayers[playerId] = [];
        }
      });

      socket.emit('gameInProgress', {
        roomId,
        players: room.players,
        playersData: room.playersData,
        creator: room.creator,
        gameSettings: room.gameSettings,
        scores: room.scores,
        questions: questionsForClient,
        currentQuestion: room.currentQuestion,
        userQuestionIds: userQuestionIdsForPlayers // Enviar los IDs de preguntas de cada jugador
      });
    } else {
      // Sala terminada o en otro estado
      socket.emit('roomStateInfo', {
        roomId,
        status: room.status,
        message: `La sala está en estado: ${room.status}`
      });
    }
  });



  // Enviar respuesta del jugador
  socket.on('submitAnswer', (data) => {
    const { roomId, userId, questionIndex, answer } = data;
    const room = gameRooms.get(roomId);
    if (room) {
      // Obtener la pregunta actual desde la sala
      const currentQuestion = room.questions[questionIndex];
      if (!currentQuestion) {
        console.error(`Pregunta no encontrada para índice ${questionIndex} en sala ${roomId}`);
        return;
      }

      // Verificar respuesta usando las preguntas de la sala
      const isCorrect = answer === currentQuestion.correctAnswer;
      const points = isCorrect ? 10 : 0;

      // Inicializar contador de respuestas correctas si no existe
      if (!room.correctAnswers[userId]) {
        room.correctAnswers[userId] = 0;
      }

      // Actualizar contador de respuestas correctas
      if (isCorrect) {
        room.correctAnswers[userId] += 1;
      }

      // Inicializar respuestas de la pregunta si no existe
      if (!room.questionAnswers[questionIndex]) {
        room.questionAnswers[questionIndex] = {};
      }

      // Guardar respuesta del jugador
      room.questionAnswers[questionIndex][userId] = {
        answer,
        isCorrect,
        points,
        timestamp: new Date().toISOString()
      };

      // Actualizar puntuación
      if (!room.scores[userId]) {
        room.scores[userId] = 0;
      }
      room.scores[userId] += points;

      // Verificar si ambos jugadores respondieron **************
      const answeredPlayers = Object.keys(room.questionAnswers[questionIndex]);
      const connectedPlayers = room.players.filter(playerId =>
        room.playersData[playerId]?.connected !== false
      );
      const bothAnswered = connectedPlayers.length === 2 && answeredPlayers.length === 2;

      if (bothAnswered) {
        // enviar resultados de la preguntas  
        try {
          io.to(roomId).emit('questionResults', {
            roomId,
            questionIndex,
            answers: room.questionAnswers[questionIndex],
            scores: room.scores,
            correctAnswer: currentQuestion.correctAnswer,
            //indice de la pregunta
            index: currentQuestion.index,
            questionId: currentQuestion.questionId
          });
        } catch (error) {
          console.log(`error al enviar los resultados de la pregunta ${questionIndex} a ${roomId}: ${error}`);
        }
        // Después de 2 segundos, pasar a la siguiente pregunta
        setTimeout(() => {
          room.currentQuestion++;

          if (room.currentQuestion >= room.questions.length) { // *************
            // Juego terminado
            room.status = 'finished';
            io.to(roomId).emit('gameFinished', {
              roomId,
              finalScores: room.scores,
              playersData: room.playersData,
              correctAnswers: room.correctAnswers, // Agregar esta línea
              totalQuestions: room.questions.length // Agregar esta línea
            });

            // Programar limpieza automática después de 10 minutos si nadie sale
            const cleanupTimeout = setTimeout(() => {
              const roomToClean = gameRooms.get(roomId);
              if (roomToClean && roomToClean.status === 'finished') {
                gameRooms.delete(roomId);
              }
            }, 600000); // 10 minutos

            roomTimeouts.set(roomId, cleanupTimeout);
          } else {
            // Siguiente pregunta
            io.to(roomId).emit('nextQuestion', {
              roomId,
              currentQuestion: room.currentQuestion,
              scores: room.scores
            });
          }
        }, 2000);
      } else {
        // Notificar que un jugador respondió
        io.to(roomId).emit('playerAnswered', {
          roomId,
          questionIndex,
          answeredPlayers,
          waitingFor: connectedPlayers.filter(p => !answeredPlayers.includes(p))
        });
      }
    }
  });

  // Desconectar usuario
  socket.on('disconnect', () => {
    //    console.log(`Usuario desconectado: ${socket.id}`);

    if (socket.roomId && socket.userId) {
      const room = gameRooms.get(socket.roomId);
      if (room) {
        // Marcar jugador como desconectado en lugar de eliminarlo inmediatamente
        if (room.playersData[socket.userId]) {
          room.playersData[socket.userId].connected = false;
          room.playersData[socket.userId].disconnectedAt = new Date().toISOString();

          // Verificar si todos los jugadores están desconectados
          const connectedPlayers = room.players.filter(playerId =>
            room.playersData[playerId]?.connected !== false
          );

          if (connectedPlayers.length === 0) {
            // Solo programar eliminación si el juego está en espera o terminado
            if (room.status === 'waiting') {
              if (roomTimeouts.has(socket.roomId)) {
                clearTimeout(roomTimeouts.get(socket.roomId));
              }

              const timeout = setTimeout(() => {
                const roomToDelete = gameRooms.get(socket.roomId);
                if (roomToDelete) {
                  const stillConnected = roomToDelete.players.filter(playerId =>
                    roomToDelete.playersData[playerId]?.connected !== false
                  );

                  if (stillConnected.length === 0) {
                    gameRooms.delete(socket.roomId);
                    roomTimeouts.delete(socket.roomId);
                  }
                }
              }, 300000); // 5 minutos de gracia

              roomTimeouts.set(socket.roomId, timeout);
            } else if (room.status === 'finished') {
              // Si el juego terminó, mantener la sala por 10 minutos para que los jugadores puedan ver resultados
              if (roomTimeouts.has(socket.roomId)) {
                clearTimeout(roomTimeouts.get(socket.roomId));
              }

              const timeout = setTimeout(() => {
                const roomToDelete = gameRooms.get(socket.roomId);
                if (roomToDelete) {
                  const stillConnected = roomToDelete.players.filter(playerId =>
                    roomToDelete.playersData[playerId]?.connected !== false
                  );

                  if (stillConnected.length === 0) {
                    gameRooms.delete(socket.roomId);
                    roomTimeouts.delete(socket.roomId);
                  }
                }
              }, 600000); // 10 minutos de gracia para salas terminadas

              roomTimeouts.set(socket.roomId, timeout);
            } else {
              console.log(`Sala ${socket.roomId} está en juego, no se programará eliminación automática`);
            }
          } else {
            // Notificar a los demás jugadores que alguien se desconectó
            io.to(socket.roomId).emit('playerDisconnected', {
              roomId: socket.roomId,
              disconnectedPlayerId: socket.userId,
              players: room.players,
              playersData: room.playersData,
              creator: room.creator,
              gameSettings: room.gameSettings
            });
          }
        }
      }
    }
  });

  // Salir de sala manualmente
  socket.on('leaveRoom', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      const playerIndex = room.players.indexOf(userId);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        delete room.playersData[userId];

        // Si no quedan jugadores, eliminar la sala inmediatamente
        if (room.players.length === 0) {
          // Cancelar timeout si existe
          if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
          }

          gameRooms.delete(roomId);
        } else {
          // Notificar a los demás jugadores
          io.to(roomId).emit('playerLeft', {
            roomId,
            players: room.players,
            playersData: room.playersData,
            creator: room.creator,
            gameSettings: room.gameSettings
          });
        }
      }
    }

    socket.leave(roomId);
  });

  // Evento para limpiar sala cuando termine el juego
  socket.on('cleanupRoom', (data) => {
    const { roomId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Cancelar timeout si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      // Eliminar la sala inmediatamente
      gameRooms.delete(roomId);

      // Notificar a todos los jugadores que la sala fue eliminada
      io.to(roomId).emit('roomCleaned', {
        roomId,
        message: 'Sala eliminada después del juego'
      });
    }
  });

  // Evento para salir después del juego terminado
  socket.on('leaveAfterGame', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.status === 'finished') {
      const playerIndex = room.players.indexOf(userId);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        delete room.playersData[userId];


        // Si no quedan jugadores, eliminar la sala inmediatamente
        if (room.players.length === 0) {
          // Cancelar timeout si existe
          if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts.get(roomId));
            roomTimeouts.delete(roomId);
          }

          gameRooms.delete(roomId);
        }
      }
    }

    socket.leave(roomId);
  });

  // Evento para forzar limpieza de salas (para debugging)
  socket.on('forceCleanup', (data) => {
    const { roomId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Cancelar timeout si existe
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts.get(roomId));
        roomTimeouts.delete(roomId);
      }

      // Eliminar la sala
      gameRooms.delete(roomId);

      // Notificar a todos los jugadores
      io.to(roomId).emit('roomCleaned', {
        roomId,
        message: 'Sala forzada a limpiar'
      });
    }
  });
  // Evento para reiniciar el juego
  socket.on('gameStateReset', (data) => {
    const { roomId, shouldShowResults = false } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Preservar los scores finales antes de resetear
      const finalScores = { ...room.scores };
      const playersData = { ...room.playersData };
      const questionsCount = room.questions.length; // Preservar el número de preguntas

      // Resetear solo el estado del juego, NO los jugadores
      room.status = 'waiting';
      // NO limpiar room.players ni room.playersData
      room.questionAnswers = {};
      room.scores = {};
      room.currentQuestion = 0;
      room.questions = [];

      // LIMPIAR LAS PREGUNTAS PENDIENTES PARA FORZAR NUEVAS PREGUNTAS
      room.pendingQuestions = {};
      room.correctAnswers = {}; // Limpiar respuestas correctas

      // Resetear el estado "ready" de todos los jugadores
      Object.keys(room.playersData).forEach(playerId => {
        if (room.playersData[playerId]) {
          room.playersData[playerId].ready = false;
          // También limpiar los userQuestionIds para forzar nuevas preguntas
          room.playersData[playerId].userQuestionIds = [];
        }
      });


      // Solo enviar finalScores si se solicita explícitamente
      const resetData = {
        roomId,
        message: 'Juego reiniciado',
        players: room.players, // Incluir la lista de jugadores
        playersData: playersData,
        creator: room.creator, // Incluir la información del creador
        gameSettings: room.gameSettings, // Incluir la configuración del juego
        questionsCount: questionsCount,
        //showResults: shouldShowResults
      };

      if (shouldShowResults && Object.keys(finalScores).length > 0) {
        resetData.finalScores = finalScores;
      }

      // Notificar a todos los jugadores
      io.to(roomId).emit('gameStateReset', resetData);
    }
  });

  // Evento para solicitar sincronización del estado de resultados
  socket.on('requestResultsSync', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room) {
      // Determinar si se deben mostrar resultados basado en el estado de la sala
      const shouldShowResults = room.status === 'finished' && Object.keys(room.scores).length > 0;

      const syncData = {
        roomId,
        showResults: shouldShowResults
      };

      if (shouldShowResults) {
        syncData.gameResults = {
          scores: room.scores,
          totalQuestions: room.questions.length || 0,
          currentUserId: userId
        };
      }

      // Enviar solo al jugador que solicitó la sincronización
      socket.emit('syncResultsState', syncData);
    }
  });

  // Evento para cuando un jugador está listo para revancha
  socket.on('playerReadyForRematch', (data) => {
    const { roomId, userId } = data;
    const room = gameRooms.get(roomId);

    if (room && room.playersData[userId]) {
      // Marcar solo este jugador como listo para revancha
      room.playersData[userId].readyForRematch = true;
      room.playersData[userId].ready = false; // Resetear el estado de listo


      // Verificar si ambos jugadores están listos para revancha
      const allReadyForRematch = room.players.every(playerId =>
        room.playersData[playerId]?.readyForRematch
      );

      if (allReadyForRematch) {
        // Ambos están listos para revancha, hacer reset completo
        const finalScores = { ...room.scores };
        const playersData = { ...room.playersData };
        const questionsCount = room.questions.length;

        // Resetear el estado del juego
        room.status = 'waiting';
        room.questionAnswers = {};
        room.scores = {};
        room.currentQuestion = 0;
        room.questions = [];
        room.pendingQuestions = {};
        room.correctAnswers = {}; // Limpiar respuestas correctas

        // Resetear el estado "ready" de todos los jugadores
        Object.keys(room.playersData).forEach(playerId => {
          if (room.playersData[playerId]) {
            room.playersData[playerId].ready = false;
            room.playersData[playerId].readyForRematch = false; // Limpiar estado de revancha
            room.playersData[playerId].userQuestionIds = [];
          }
        });


        // Notificar a todos los jugadores que el juego se reinició
        io.to(roomId).emit('gameStateReset', {
          roomId,
          message: 'Juego reiniciado para revancha',
          players: room.players,
          playersData: playersData,
          creator: room.creator,
          gameSettings: room.gameSettings,
          questionsCount: questionsCount,
          //showResults: false, // No mostrar resultados para nadie cuando ambos están listos
          rematchInitiator: userId
        });
      } else {
        // Solo un jugador está listo, notificar actualización
        io.to(roomId).emit('playerStatusUpdated', {
          roomId,
          players: room.players,
          playersData: room.playersData,
          creator: room.creator,
          gameSettings: room.gameSettings
        });
      }
    }
  });

});



// Iniciar servidor
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Socket.IO habilitado`);
})