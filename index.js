import express from 'express';
import { criarAplicacao } from './servidor.js';

export default await criarAplicacao({ app: express() });
