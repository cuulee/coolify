import cuid from 'cuid';
import type { FastifyRequest } from 'fastify';
import { FastifyReply } from 'fastify';
import yaml from 'js-yaml';
import fs from 'fs/promises';
import { ComposeFile, createDirectories, decrypt, encrypt, errorHandler, executeDockerCmd, generateDatabaseConfiguration, generatePassword, getContainerUsage, getDatabaseImage, getDatabaseVersions, getFreePublicPort, listSettings, makeLabelForStandaloneDatabase, prisma, startTraefikTCPProxy, stopDatabaseContainer, stopTcpHttpProxy, supportedDatabaseTypesAndVersions, uniqueName, updatePasswordInDb } from '../../../../lib/common';
import { day } from '../../../../lib/dayjs';

import { GetDatabaseLogs, OnlyId, SaveDatabase, SaveDatabaseDestination, SaveDatabaseSettings, SaveVersion } from '../../../../types';
import { SaveDatabaseType } from './types';

export async function listDatabases(request: FastifyRequest) {
    try {
        const teamId = request.user.teamId;
        const databases = await prisma.database.findMany({
            where: { teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { teams: true, destinationDocker: true }
        });
        return {
            databases
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function newDatabase(request: FastifyRequest, reply: FastifyReply) {
    try {
        const teamId = request.user.teamId;

        const name = uniqueName();
        const dbUser = cuid();
        const dbUserPassword = encrypt(generatePassword());
        const rootUser = cuid();
        const rootUserPassword = encrypt(generatePassword());
        const defaultDatabase = cuid();

        const { id } = await prisma.database.create({
            data: {
                name,
                defaultDatabase,
                dbUser,
                dbUserPassword,
                rootUser,
                rootUserPassword,
                teams: { connect: { id: teamId } },
                settings: { create: { isPublic: false } }
            }
        });
        return reply.code(201).send({ id })
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function getDatabaseStatus(request: FastifyRequest<OnlyId>) {
    try {
        const { id } = request.params;
        const teamId = request.user.teamId;
        let isRunning = false;

        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        const { destinationDockerId, destinationDocker } = database;
        if (destinationDockerId) {
            try {
                const { stdout } = await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker inspect --format '{{json .State}}' ${id}` })

                if (JSON.parse(stdout).Running) {
                    isRunning = true;
                }
            } catch (error) {
                //
            }
        }
        return {
            isRunning
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}

export async function getDatabase(request: FastifyRequest<OnlyId>) {
    try {
        const { id } = request.params;
        const teamId = request.user.teamId;
        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        if (!database) {
            throw { status: 404, message: 'Database not found.' }
        }
        const { arch } = await listSettings();
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        const configuration = generateDatabaseConfiguration(database, arch);
        const settings = await listSettings();
        return {
            privatePort: configuration?.privatePort,
            database,
            versions: await getDatabaseVersions(database.type, arch),
            settings
        };
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function getDatabaseTypes(request: FastifyRequest) {
    try {
        return {
            types: supportedDatabaseTypesAndVersions
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function saveDatabaseType(request: FastifyRequest<SaveDatabaseType>, reply: FastifyReply) {
    try {
        const { id } = request.params;
        const { type } = request.body;
        await prisma.database.update({
            where: { id },
            data: { type }
        });
        return reply.code(201).send({})
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function getVersions(request: FastifyRequest<OnlyId>) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;
        const { type } = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        const { arch } = await listSettings();
        const versions = getDatabaseVersions(type, arch);
        return {
            versions
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function saveVersion(request: FastifyRequest<SaveVersion>, reply: FastifyReply) {
    try {
        const { id } = request.params;
        const { version } = request.body;

        await prisma.database.update({
            where: { id },
            data: {
                version,
            }
        });
        return reply.code(201).send({})
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function saveDatabaseDestination(request: FastifyRequest<SaveDatabaseDestination>, reply: FastifyReply) {
    try {
        const { id } = request.params;
        const { destinationId } = request.body;

        await prisma.database.update({
            where: { id },
            data: { destinationDocker: { connect: { id: destinationId } } }
        });

        const {
            destinationDockerId,
            destinationDocker: { engine, id: dockerId },
            version,
            type
        } = await prisma.database.findUnique({ where: { id }, include: { destinationDocker: true } });

        if (destinationDockerId) {
            if (type && version) {
                const baseImage = getDatabaseImage(type);
                executeDockerCmd({ dockerId, command: `docker pull ${baseImage}:${version}` })
            }
        }
        return reply.code(201).send({})
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function getDatabaseUsage(request: FastifyRequest<OnlyId>) {
    try {
        const { id } = request.params;
        const teamId = request.user.teamId;
        let usage = {};

        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        if (database.destinationDockerId) {
            [usage] = await Promise.all([getContainerUsage(database.destinationDocker.id, id)]);
        }
        return {
            usage
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function startDatabase(request: FastifyRequest<OnlyId>) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;

        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        const { arch } = await listSettings();
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        const {
            type,
            destinationDockerId,
            destinationDocker,
            publicPort,
            settings: { isPublic }
        } = database;
        const { privatePort, command, environmentVariables, image, volume, ulimits } =
            generateDatabaseConfiguration(database, arch);

        const network = destinationDockerId && destinationDocker.network;
        const volumeName = volume.split(':')[0];
        const labels = await makeLabelForStandaloneDatabase({ id, image, volume });

        const { workdir } = await createDirectories({ repository: type, buildId: id });

        const composeFile: ComposeFile = {
            version: '3.8',
            services: {
                [id]: {
                    container_name: id,
                    image,
                    command,
                    networks: [network],
                    environment: environmentVariables,
                    volumes: [volume],
                    ulimits,
                    labels,
                    restart: 'always',
                    deploy: {
                        restart_policy: {
                            condition: 'on-failure',
                            delay: '5s',
                            max_attempts: 3,
                            window: '120s'
                        }
                    }
                }
            },
            networks: {
                [network]: {
                    external: true
                }
            },
            volumes: {
                [volumeName]: {
                    external: true
                }
            }
        };

        const composeFileDestination = `${workdir}/docker-compose.yaml`;
        await fs.writeFile(composeFileDestination, yaml.dump(composeFile));
        try {
            await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker volume create ${volumeName}` })
        } catch (error) {
            console.log(error);
        }
        try {
            await executeDockerCmd({ dockerId: destinationDocker.id, command: `docker compose -f ${composeFileDestination} up -d` })
            if (isPublic) await startTraefikTCPProxy(destinationDocker, id, publicPort, privatePort);
            return {};
        } catch (error) {
            console.log(error)
            throw {
                error
            };
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function stopDatabase(request: FastifyRequest<OnlyId>) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;
        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        const everStarted = await stopDatabaseContainer(database);
        if (everStarted) await stopTcpHttpProxy(id, database.destinationDocker, database.publicPort);
        await prisma.database.update({
            where: { id },
            data: {
                settings: { upsert: { update: { isPublic: false }, create: { isPublic: false } } }
            }
        });
        await prisma.database.update({ where: { id }, data: { publicPort: null } });
        return {};

    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function getDatabaseLogs(request: FastifyRequest<GetDatabaseLogs>) {
    try {
        const { id } = request.params;
        let { since = 0 } = request.query
        if (since !== 0) {
            since = day(since).unix();
        }
        const { destinationDockerId, destinationDocker: { id: dockerId } } = await prisma.database.findUnique({
            where: { id },
            include: { destinationDocker: true }
        });
        if (destinationDockerId) {
            try {
                // const found = await checkContainer({ dockerId, container: id })
                // if (found) {
                const { default: ansi } = await import('strip-ansi')
                const { stdout, stderr } = await executeDockerCmd({ dockerId, command: `docker logs --since ${since} --tail 5000 --timestamps ${id}` })
                const stripLogsStdout = stdout.toString().split('\n').map((l) => ansi(l)).filter((a) => a);
                const stripLogsStderr = stderr.toString().split('\n').map((l) => ansi(l)).filter((a) => a);
                const logs = stripLogsStderr.concat(stripLogsStdout)
                const sortedLogs = logs.sort((a, b) => (day(a.split(' ')[0]).isAfter(day(b.split(' ')[0])) ? 1 : -1))
                return { logs: sortedLogs }
                // }
            } catch (error) {
                const { statusCode } = error;
                if (statusCode === 404) {
                    return {
                        logs: []
                    };
                }
            }
        }
        return {
            message: 'No logs found.'
        }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function deleteDatabase(request: FastifyRequest<OnlyId>) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;
        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        if (database.destinationDockerId) {
            const everStarted = await stopDatabaseContainer(database);
            if (everStarted) await stopTcpHttpProxy(id, database.destinationDocker, database.publicPort);
        }
        await prisma.databaseSettings.deleteMany({ where: { databaseId: id } });
        await prisma.database.delete({ where: { id } });
        return {}
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function saveDatabase(request: FastifyRequest<SaveDatabase>, reply: FastifyReply) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;
        const {
            name,
            defaultDatabase,
            dbUser,
            dbUserPassword,
            rootUser,
            rootUserPassword,
            version,
            isRunning
        } = request.body;
        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);
        if (isRunning) {
            if (database.dbUserPassword !== dbUserPassword) {
                await updatePasswordInDb(database, dbUser, dbUserPassword, false);
            } else if (database.rootUserPassword !== rootUserPassword) {
                await updatePasswordInDb(database, rootUser, rootUserPassword, true);
            }
        }
        const encryptedDbUserPassword = dbUserPassword && encrypt(dbUserPassword);
        const encryptedRootUserPassword = rootUserPassword && encrypt(rootUserPassword);
        await prisma.database.update({
            where: { id },
            data: {
                name,
                defaultDatabase,
                dbUser,
                dbUserPassword: encryptedDbUserPassword,
                rootUser,
                rootUserPassword: encryptedRootUserPassword,
                version
            }
        });
        return reply.code(201).send({})
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}
export async function saveDatabaseSettings(request: FastifyRequest<SaveDatabaseSettings>) {
    try {
        const teamId = request.user.teamId;
        const { id } = request.params;
        const { isPublic, appendOnly = true } = request.body;

        const { destinationDocker: { id: dockerId } } = await prisma.database.findUnique({ where: { id }, include: { destinationDocker: true } })
        const publicPort = await getFreePublicPort(id, dockerId);

        await prisma.database.update({
            where: { id },
            data: {
                settings: { upsert: { update: { isPublic, appendOnly }, create: { isPublic, appendOnly } } }
            }
        });
        const database = await prisma.database.findFirst({
            where: { id, teams: { some: { id: teamId === '0' ? undefined : teamId } } },
            include: { destinationDocker: true, settings: true }
        });
        const { arch } = await listSettings();
        if (database.dbUserPassword) database.dbUserPassword = decrypt(database.dbUserPassword);
        if (database.rootUserPassword) database.rootUserPassword = decrypt(database.rootUserPassword);

        const { destinationDockerId, destinationDocker, publicPort: oldPublicPort } = database;
        const { privatePort } = generateDatabaseConfiguration(database, arch);

        if (destinationDockerId) {
            if (isPublic) {
                await prisma.database.update({ where: { id }, data: { publicPort } });
                await startTraefikTCPProxy(destinationDocker, id, publicPort, privatePort);
            } else {
                await prisma.database.update({ where: { id }, data: { publicPort: null } });
                await stopTcpHttpProxy(id, destinationDocker, oldPublicPort);
            }
        }
        return { publicPort }
    } catch ({ status, message }) {
        return errorHandler({ status, message })
    }
}