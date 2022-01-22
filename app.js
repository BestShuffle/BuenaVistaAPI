const config = require('./config.js');
const express = require('express');
const app = express();
const cors = require('cors');
const {Pool} = require('pg');
const sql = require('mysql');

const https = require('https');

const jwt = require('jsonwebtoken');
const fs = require('fs');

const nodemailer = require('nodemailer');

const expressJwt = require('express-jwt');
const crypto = require('crypto');

const spawn = require("child_process").spawn;

const secureRandomPassword = require('secure-random-password');

const multer = require('multer');
const upload = multer();
const type = upload.single('file');
const request = require('request');

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

const ODOO_CONNECTION_STRING = 'postgresql://' + config.ODOO_BDD_USER + ':' + config.ODOO_BDD_PASSWORD + '@' +
    config.ODOO_BDD_HOST + ':' + config.ODOO_BDD_PORT + '/' + config.ODOO_BDD_DATABASE;
const odooConnection = new Pool({
    connectionString: ODOO_CONNECTION_STRING,
    ssl: false
});

const RSA_PUBLIC_KEY = fs.readFileSync(config.API_PATH_JWT_PUBLIC_KEY);
const RSA_PRIVATE_KEY = fs.readFileSync(config.API_PATH_JWT_PRIVATE_KEY);

const checkIfAuthenticated = expressJwt({
    secret: RSA_PUBLIC_KEY,
    algorithms: ['RS256']
}).unless({
    path: ['/login', '/']
});

/* LOGS DANS FICHIERS
const proc = require('proc');

var writeStream = fs.createWriteStream('./logs/api' + Date.now() + '.log', {
    encoding: 'utf8',
    flags: 'w'
});

process.stdout = require('stream').Writable();
process.stdout._write = function (chunk, encoding, callback) {
    writeStream.write(chunk + "\r\n", encoding, callback);
};

process.stderr = require('stream').Writable();
process.stderr._write = function (chunk, encoding, callback) {
    writeStream.write("ERROR :\r\n" + chunk + "\r\n", encoding, callback);
};
// FIN LOGS */


app.use(function (req, res, next) {

    if (err instanceof SyntaxError && err.status === 400) {
        console.error(err);
        return res.sendStatus(400); // Bad request
    }

    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const connConfig = {
    host: config.BDD_HOST,
    user: config.BDD_USER,
    port: config.BDD_PORT,
    password: config.BDD_PASSWORD,
    database: config.BDD_DATABASE
};

// app.use(upload.array());
app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cors());

const bodyParser = require('body-parser');
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({extended: true})); // support encoded bodies

module.exports = app;

// Orders
app.route('/api/orders').post(checkIfAuthenticated, getOrders);
app.route('/api/orders/search').post(checkIfAuthenticated, searchOrders);
app.route('/api/orders/consumer/:id').post(checkIfAuthenticated, getConsumerOrders);
app.route('/api/orders/:id').get(checkIfAuthenticated, getOrder);
// Clients
app.route('/api/clients').post(checkIfAuthenticated, getClients);
app.route('/api/clients/:id').get(checkIfAuthenticated, getClient);
app.route('/api/clients/search').post(checkIfAuthenticated, searchClients);
app.route('/api/clients/delete/:id').post(checkIfAuthenticated, deleteClient);
app.route('/api/clients/update/:id').post(checkIfAuthenticated, updateClient);
// Account
app.route('/api/account/create').post(checkIfAuthenticated, createAccount);
// Docs
app.route('/api/docs/product/add').post(checkIfAuthenticated, type, addDoc);

app.route('/api/docs/product/').post(checkIfAuthenticated, getDocsProducts);
app.route('/api/docs/product/:id').get(checkIfAuthenticated, getDocsProduct);
app.route('/api/docs/product/search').post(checkIfAuthenticated, searchDocsProducts);
app.route('/api/docs/delete/:id').post(checkIfAuthenticated, deleteDoc);
app.route('/api/docs/:id').get(checkIfAuthenticated, getDocs);
app.route('/api/docs/product/update').post(checkIfAuthenticated, updateDocsProduct);
app.route('/api/docs/product/delete/:id').post(checkIfAuthenticated, deleteDocsProduct);
// Doc
app.route('/api/doc/:id').get(checkIfAuthenticated, getDoc);
app.route('/api/doc/update').post(checkIfAuthenticated, updateDoc);
// Files
app.route('/api/files/:id').get(checkIfAuthenticated, getFile);

// Product
app.route('/api/product/create').post(checkIfAuthenticated, createProduct);

function deleteDoc(req, res) {
    // Récupération des données token décryptées
    let file = req.file;
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let docId = req.params.id;
    // Ecrire en BDD
    let connection = sql.createConnection(connConfig);
    connection.query('DELETE FROM docs WHERE id = ?',
        [docId],
        function (error, results, fields) {
            if (error) throw error;
            if (results) {
                res.send();
                postStats(req, {author:accountId, obj:docId}, 'CHERCHEUR - BV - Suppression d\'un document',
                    'DELETE');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function getFile(req, res) {
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let fileId = req.params.id;

    let connection = sql.createConnection(connConfig);
    connection.query('SELECT path FROM docs WHERE id = ?',
        [fileId],
        function (error, results, fields) {
            if (error) throw error;
            if (results && results[0]) {
                res.download(results[0].path);
                postStats(req, {author:accountId, obj:fileId}, 'CHERCHEUR - BV - Récupération d\'un document',
                    'DOWNLOAD');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function createProduct(req, res) {
    let product = req.body.product;
    let decodedReq = req.user;
    let accountLogin = decodedReq.id;
    createOdooProduct(req, product, accountLogin, (idOdooProduct) => {
        createBvProduct(req, product, accountLogin, idOdooProduct, () => {
            res.send();
            postStats(req, {author:accountLogin, obj:product}, 'CHERCHEUR - Création d\'un produit',
                'INSERT');
        }, () => {
            res.status(500).send();
        });
    }, () => {
        res.status(500).send();
    });
}

function createOdooProduct(req, product, loginAccount, success, failure) {
    odooConnection.query('INSERT INTO product_template (name,sequence,description,type,categ_id,list_price,volume,weight,' +
        'sale_ok,purchase_ok,uom_id,uom_po_id,active,create_uid,create_date,write_uid,write_date,tracking,' +
        'produce_delay,service_type,sale_line_warn,purchase_line_warn)'+
        ' VALUES ($1,1,$2,\'product\', 2, 0, 0, 0, false, false, 1, 1, true, (SELECT id FROM res_users WHERE login=$3),' +
        ' NOW(), (SELECT id FROM res_users WHERE login=$3), NOW(), \'none\', 0, \'manual\', \'no-message\', \'no-message\')' +
        ' RETURNING id',
        [product.name, product.description, loginAccount], (error, results) => {
            if (error) {
                failure();
                throw error;
            }
            if (results) {
                let idTemplate = results.rows[0].id;
                odooConnection.query('INSERT INTO product_product (active,product_tmpl_id,weight,create_uid,' +
                    'create_date,write_uid,write_date)' +
                    'VALUES (true, $1, 0, (SELECT id FROM res_users WHERE login=$2), NOW(), (SELECT id FROM res_users WHERE login=$2), NOW()) ' +
                    'RETURNING id',
                    [idTemplate, loginAccount], (error, results) => {
                        if (error) {
                            failure();
                            throw error;
                        }
                        if (results) {
                            let idProduct = results.rows[0].id;
                            postStats(req, {author:loginAccount, obj:product}, 'CHERCHEUR - ODOO - Création d\'un produit',
                                'INSERT');
                            success(idProduct);
                        }
                    });
            }
            });
}

function createBvProduct(req, product, accountLogin, idOdooProduct, success, failure) {
    let connection = sql.createConnection(connConfig);
    connection.query('INSERT INTO product (id,name,description,idCategory) VALUES (?,?,?,2)',
        [idOdooProduct, product.name, product.description],
        function (error, results, fields) {
            if (error) throw error;
            if (results) {
                connection.query('UPDATE docs_product SET idProduct = ? WHERE id = ?',
                    [idOdooProduct, product.id],
                    function (error, results, fields) {
                        if (error) throw error;
                        if (results) {
                            success();
                            postStats(req, {author:accountLogin, obj:product}, 'CHERCHEUR - BV - Création d\'un produit',
                                'INSERT');
                        }
                    });
            } else {
                failure();
            }
        });
}

function addDoc(req, res) {
    // Récupération des données token décryptées
    let file = req.file;
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let docsProduct = req.body.docsProduct;
    // Ecrire en BDD
    let connection = sql.createConnection(connConfig);
    connection.query('INSERT INTO docs_product (name, description, state) VALUES (?,?,0)',
        [docsProduct.name, docsProduct.description],
        function (error, results, fields) {
            if (error) throw error;
            if (results) {
                res.send({messageSuccess: 'Le produit a bien été créé'});
                postStats(req, {author:accountLogin, obj:docsProduct}, 'CHERCHEUR - BV - Création d\'un suivi de création de produit',
                    'INSERT');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function getDocsProducts(req, res) {
    let connection = sql.createConnection(connConfig);
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(id) AS length" +
            " FROM docs_product", function (error, results, fields) {
            if (results) {
                jsonResult.length = results[0].length;
            }
        });
    }
    connection.query("SELECT id, name, description, state, idProduct FROM docs_product d ORDER BY name LIMIT ?,?",
        [min, pageSize], function (error, results, fields) {
            if (error) throw error;

            let list = [];

            results.forEach(function (data) {
                let json = {};
                json.id = data.id;
                json.name = data.name;
                json.description = data.description;
                json.state = data.state;
                json.idProduct = data.idProduct;
                list.push(json);
            });

            jsonResult.list = list;
            jsonResult.min = min;
            jsonResult.max = max;
            jsonResult.pageSize = pageSize;
            jsonResult.pageIndex = pageIndex;

            res.send(jsonResult);
            postStats(req, {author:accountId, obj:jsonResult}, 'CHERCHEUR - BV - Récupération des suivis de création de produits',
                'SELECT');
        });
    connection.end();
}

function updateDocsProduct(req, res) {
    let connection = sql.createConnection(connConfig);
    let docsProduct = req.body.docsProduct;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query('UPDATE docs_product SET name = ?, description = ?, state = ? WHERE id = ?',
        [docsProduct.name, docsProduct.description, docsProduct.state, docsProduct.id], function (error, results, fields) {
            if (error) throw error;

            if (results) {
                res.send();
                postStats(req, {author:accountId, obj:docsProduct}, 'CHERCHEUR - BV - Mise à jour d\'un suivi de création de produit',
                    'UPDATE');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function searchDocsProducts(req, res) {
    let connection = sql.createConnection(connConfig);
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let searchValue = req.body.value;
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(id) AS length " +
            "FROM docs_product " +
            "WHERE name LIKE ? OR description LIKE ?",
            [`%${searchValue}%`,`%${searchValue}%`],
            function (error, results, fields) {
            if (results) {
                jsonResult.length = results[0].length;
            }
        });
    }
    connection.query("SELECT id, name, description, state, idProduct FROM docs_product d WHERE name LIKE ? OR description LIKE ? ORDER BY name LIMIT ?,?",
        [`%${searchValue}%`, `%${searchValue}%`, min, pageSize], function (error, results, fields) {
            if (error) throw error;

            let list = [];

            results.forEach(function (data) {
                let json = {};
                json.id = data.id;
                json.name = data.name;
                json.description = data.description;
                json.state = data.state;
                json.idProduct = data.idProduct;
                list.push(json);
            });

            jsonResult.list = list;
            jsonResult.min = min;
            jsonResult.max = max;
            jsonResult.pageSize = pageSize;
            jsonResult.pageIndex = pageIndex;

            res.send(jsonResult);
            postStats(req, {author:accountId, obj:jsonResult}, 'CHERCHEUR - BV - Récupération des suivis de création de produits',
                'SELECT');
        });
    connection.end();
}

function getDoc(req, res) {
    let connection = sql.createConnection(connConfig);
    let docId = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("SELECT d.id, d.name, d.path, d.state, c.displayName AS uploader " +
        "FROM docs d " +
        "JOIN account a ON d.idAccount = a.id " +
        "JOIN contact c ON a.idContact = c.id " +
        "WHERE d.id = ?",
        [docId], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let data = results[0];
                let json = {};
                json.id = data.id;
                json.name = data.name;
                json.path = data.path;
                json.state = data.state;
                json.uploader = data.uploader;
                res.send(json);
                postStats(req, {author:accountId, obj:docsProduct}, 'CHERCHEUR - BV - Récupération d\'un document',
                    'SELECT');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}


function updateDoc(req, res) {
    let connection = sql.createConnection(connConfig);
    let doc = req.body.doc;
    let id = doc.id;
    let field = req.body.field;
    let value = doc[field];
    let authorizedFields = ['name'];
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (!authorizedFields.includes(field)) {
        res.status(500).send();
    }

    connection.query('UPDATE docs SET ' + field + ' = ? WHERE id = ?',
        [value, id], function (error, results, fields) {
            if (error) throw error;

            if (results) {
                res.send({messageSuccess: 'Nom mis à jour'});
                postStats(req, {author:accountId, obj:docsProduct}, 'CHERCHEUR - BV - Mise à jour d\'un document',
                    'UPDATE');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function getDocs(req, res) {
    let connection = sql.createConnection(connConfig);
    let docsProductId = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("SELECT d.id, d.name, d.path, d.state, c.displayName AS uploader " +
        "FROM docs d " +
        "JOIN account a ON d.idAccount = a.id " +
        "JOIN contact c ON a.idContact = c.id " +
        "WHERE d.idDocsProduct = ?",
        [docsProductId], function (error, results, fields) {
            if (error) throw error;

            if (results) {
                let list = [];
                list[0] = [];
                list[1] = [];
                list[2] = [];
                list[3] = [];
                results.forEach(data => {
                    let stateList = list[data.state];
                    let json = {};
                    json.id = data.id;
                    json.name = data.name;
                    json.path = data.path;
                    json.state = data.state;
                    json.uploader = data.uploader;
                    stateList.push(json);
                });

                res.send(list);
                postStats(req, {author:accountId, obj:list}, 'CHERCHEUR - BV - Récupération des documents d\'un suivi de création de produit',
                    'SELECT');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function getDocsProduct(req, res) {
    let connection = sql.createConnection(connConfig);
    let docsProductId = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("SELECT id, name, description, state, idProduct FROM docs_product WHERE id = ?",
        [docsProductId], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let data = results[0];
                let json = {};
                json.id = data.id;
                json.name = data.name;
                json.description = data.description;
                json.state = data.state;
                json.idProduct = data.idProduct;

                res.send(json);
                postStats(req, {author:accountId, obj:json}, 'CHERCHEUR - BV - Récupération d\'un suivi de création de produit',
                    'SELECT');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function deleteDocsProduct(req, res) {
    let connection = sql.createConnection(connConfig);
    let docsProductId = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("DELETE FROM docs WHERE idDocsProduct = ?",
        [docsProductId], function (error, results, fields) {
            if (error) throw error;
            if (results) {
                connection.query("DELETE FROM docs_product WHERE id = ?",
                    [docsProductId], function (error, results, fields) {
                        if (error) throw error;
                        if (results) {
                            res.send({ messageSuccess: 'Produit supprimé' });
                            postStats(req, {author:accountId, obj:docsProductId}, 'CHERCHEUR - BV - Suppression d\'un suivi de création de produit',
                                'DELETE');
                        }
                    });
            } else {
                res.status(500).send();
            }
        });
}

function deleteClient(req, res) {
    let connection = sql.createConnection(connConfig);
    let client = req.body.client;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    deleteClientOdoo(req, client, accountId, () => {
        deleteClientBv(req, client, accountId, () => {
            res.send();
            postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - Suppression d\'un client',
                'DELETE');
        }, () => { res.status(501).send(); });
    }, () => { res.status(501).send(); });
}

function deleteClientOdoo(req, client, accountId, success, failure) {
    odooConnection.query('DELETE FROM sale_order_line WHERE order_partner_id = $1',
        [client.idContact], (error, results) => {
            if (error) { failure(); throw error; }
            if (results) {
                odooConnection.query('DELETE FROM sale_order WHERE partner_id = $1',
                    [client.idContact], (error, results) => {
                        if (error) { failure(); throw error; }
                        if (results) {
                odooConnection.query('DELETE FROM res_groups_users_rel WHERE uid = $1',
                    [client.id], (error, results) => {
                        if (error) { failure(); throw error; }
                        if (results) {
                odooConnection.query('DELETE FROM res_users WHERE id = $1',
                    [client.id], (error, results) => {
                        if (error) { failure(); throw error; }
                        if (results) {
                            odooConnection.query('DELETE FROM res_partner WHERE id = $1',
                                [client.idContact], (error, results) => {
                                    if (error) { failure(); throw error; }
                                    if (results) {
                                        success();
                                        postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - ODOO - Suppression d\'un client',
                                            'DELETE');
                                    }
                                });
                        }
                    });
                    }
                });
                }
            });
        }
    });
}

function deleteClientBv(req, client, accountId, success, failure) {
    let connection = sql.createConnection(connConfig);
    connection.query('DELETE FROM orders_lines WHERE idContact = ?',
        [client.idContact], (error, results) => {
            if (error) { failure(); throw error; }
            if (results) {
                connection.query('DELETE FROM orders WHERE idContact = ?',
                    [client.idContact], (error, results) => {
                        if (error) { failure(); throw error; }
                        if (results) {
                            connection.query('DELETE FROM account_groups_rel WHERE idAccount = ?',
                                [client.id], (error, results) => {
                                    if (error) { failure(); throw error; }
                                    if (results) {
                                        connection.query('DELETE FROM account WHERE id = ?',
                                            [client.id], (error, results) => {
                                                if (error) { failure(); throw error; }
                                                if (results) {
                                                    connection.query('DELETE FROM contact WHERE id = ?',
                                                        [client.idContact], (error, results) => {
                                                            if (error) { failure(); throw error; }
                                                            if (results) {
                                                                success();
                                                                postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - BV - Suppression d\'un client',
                                                                    'DELETE');
                                                            }
                                    });
                        }
                    });
                    }
                });
            }
        });
        }
    });
}

function updateClient(req, res) {
    let connection = sql.createConnection(connConfig);
    let client = req.body.client;
    let isChangingPassword = req.body.isChangingPassword;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    checkIfUsernameIsTaken(req, client, accountId, () => {
        odooConnection.query('UPDATE res_partner SET name = $1, display_name = $2, email = $3, phone = $4, mobile = $5 WHERE id = ' +
            '(SELECT partner_id FROM res_users WHERE id = $6)',
            [client.name, client.displayName, client.email, client.phone, client.mobile, client.id], (error, results) => {
                if (error) { throw error; }
                if (results) {
                    let query;
                    let fields;
                    connection.query('UPDATE contact SET name = ?, displayName = ?, email = ?, phone = ?, mobile = ? WHERE id = (SELECT idContact FROM account WHERE id = ?) ',
                        [client.name, client.displayName, client.email, client.phone, client.mobile, client.id],
                        function (error, results, fields) {
                            if (error) throw error;
                            if (results) {
                                odooConnection.query('UPDATE res_users SET login = $1 WHERE partner_id = $2',
                                    [client.username, client.id], (error, results) => {
                                        if (error) {
                                            throw error;
                                        }
                                        if (results) {
                                            connection.query('UPDATE account SET username = ? WHERE id = ?',
                                                [client.username, client.id],
                                                function (error, results, fields) {
                                                    if (error) throw error;

                                                    if (results) {
                                                        if (isChangingPassword) {
                                                            updatePassword(req, client.username, client.password, accountId, () => {
                                                                res.send({messageSuccess: 'Données mises à jour'});
                                                                postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - BV+ODOO - Mise à jour d\'un client',
                                                                    'UPDATE');
                                                            }, () => {
                                                                res.status(500).send({messageError: 'Erreur lors de la mise à jour des données'});
                                                            });
                                                        } else {
                                                            res.send({messageSuccess: 'Données mises à jour'});
                                                            postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - BV+ODOO - Mise à jour d\'un client',
                                                                'UPDATE');
                                                        }
                                                    } else {
                                                        res.status(500).send({messageError: 'Erreur lors de la mise à jour des données'});
                                                    }
                                                });
                                        } else {
                                            res.status(500).send({messageError: 'Erreur lors de la mise à jour des données'});
                                        }
                                    });
                            } else {
                                res.status(500).send({messageError: 'Erreur lors de la mise à jour des données'});
                            }
                        });
                }
            });
    }, () => {
        res.status(500).send({messageError: 'L\'adresse mail est déjà utilisée'});
    });
}

function checkIfUsernameIsTaken(req, client, accountId, success, failure) {
    let connection = sql.createConnection(connConfig);
    connection.query('SELECT id FROM account WHERE username = ?',
        [client.username],
        function (error, results, fields) {
            if (error) throw error;
            if (results && results[0] && results[0].id !== client.id) {
                failure();
                postStats(req, {author:accountId, obj:client}, 'COMMERCIAL - BV+ODOO - Nom d\'utilisateur déjà ' +
                    'utilisé lors d\'une mise à jour d\'un client', 'SELECT');
            } else {
                success();
            }
        });
}

function createAccount(req, res) {
    let connection = sql.createConnection(connConfig);
    let client = req.body.client;
    let account = req.body.account;
    let decodedReq = req.user;
    let accountUsername = decodedReq.id;

    checkIfUsernameIsTaken(req, account, accountUsername, () => {
        // Création du contact
        createOdooAccount(req, client, account, accountUsername, (idClient, idAccount, cryptedPassword) => {
            client.id = idClient;
            account.id = idAccount;
            account.cryptedPassword = cryptedPassword;
            createBvAccount(req, client, account, accountUsername, () => {
                res.send();
                postStats(req, {author:accountUsername, obj:account}, 'COMMERCIAL - Création d\'un client',
                    'INSERT');
            }, () => {
                res.status(500).send({messageError: 'Erreur lors de la création du client'});
            });
        }, () => {
            res.status(500).send({messageError: 'Erreur lors de la création du client'});
        });
    }, () => {
        res.status(500).send({messageError: 'L\'adresse mail est déjà utilisée'});
    });
}

function createBvAccount(req, client, account, accountUsername, success, failure) {
    // Contact
    let connection = sql.createConnection(connConfig);
    connection.query('INSERT contact (id,name,displayName,email,phone,mobile) VALUES (?,?,?,?,?,?)',
        [client.id, client.name, client.displayName, client.email, client.phone, client.mobile],
        function (error, results, fields) {
            if (error) { failure(); throw error; }
            if (results) {
                // Compte
                connection.query('INSERT account (id,active,username,password,idContact) VALUES (?,1,?,?,?)',
                    [account.id, account.username, account.cryptedPassword, client.id],
                    function (error, results, fields) {
                        if (error) {failure(); throw error;}
                        if (results) {
                            // Ajout des groupes (38 = factures, 1 = utilisateur interne, 23 = utilisateur ,
                            // 37 = facturation, 11 = documents, 6 fonctio techniques)
                            connection.query('INSERT account_groups_rel (idGroup, idAccount) VALUES ' +
                                '(1,?),(6,?),(11,?),(23,?),(37,?),(38,?)',
                                [account.id,account.id,account.id,account.id,account.id,account.id],
                                function (error, results, fields) {
                                    if (error) {failure(); throw error;}
                                    if (results) {
                                        success();
                                        postStats(req, {author:accountUsername, obj:account}, 'COMMERCIAL - BV - Création d\'un client',
                                            'INSERT');
                                    } else {failure();}
                            });
                        } else {failure();}
                    });
            } else {failure();}
        });
}

function createOdooAccount(req, client, account, authorUsername, success, failure) {
    // Création du contact
    odooConnection.query('INSERT INTO res_partner (name,create_date,display_name,lang,tz,active,type,email,phone,mobile,is_company) ' +
        'VALUES ($1,NOW(),$1,\'fr_FR\',\'Europe/Paris\',true,\'contact\',$2, $3, $4, false) RETURNING id',
        [client.name, client.email, client.phone, client.mobile], (error, results) => {
            if (error) { failure(); throw error; }
            if (results) {
                let idPartner = results.rows[0].id;
                // Création du compte
                generateCryptedPassword(account.password, (cryptedPassword) => {
                    odooConnection.query('INSERT INTO res_users ' +
                        '(active,login,password,partner_id,company_id,create_date,share,create_uid,write_uid,write_date,notification_type,odoobot_state) ' +
                        'VALUES (true,$1,$2,$3,1,NOW(),false,(SELECT DISTINCT id FROM res_users WHERE login = $4),' +
                        '(SELECT DISTINCT id FROM res_users WHERE login = $4),NOW(),\'inbox\',\'onboarding_emoji\') RETURNING id',
                        [client.email, cryptedPassword, idPartner, authorUsername], (error, results) => {
                            if (error) { failure(); throw error; }
                            if (results) {
                                let idAccount = results.rows[0].id;
                                // Ajout des groupes (38 = factures, 1 = utilisateur interne, 23 = utilisateur ,
                                // 37 = facturation, 11 = documents, 6 fonctio techniques)
                                odooConnection.query('INSERT INTO res_groups_users_rel (gid,uid) VALUES ' +
                                    '(1,$1),(6,$1),(11,$1),(23,$1),(37,$1),(38,$1)',
                                    [idAccount], (error, results) => {
                                        if (error) { failure(); throw error; }
                                        if (results) {
                                            // Tout est ok
                                            success(idPartner, idAccount, cryptedPassword);
                                            postStats(req, {author:authorUsername, obj:account}, 'COMMERCIAL - ODOO - Création d\'un client',
                                                'INSERT');
                                        } else { failure(); }
                                    });
                            } else { failure(); }
                        });
                });
            } else { failure(); }
        });
}

function getOrders(req, res) {
    let connection = sql.createConnection(connConfig);
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(id) AS length FROM orders", function (error, results, fields) {
            if (results) {
                jsonResult.length = results[0].length;
            }
        });
        connection.query("SELECT o.id, o.name, c.name AS clientName, o.amountTotal, o.dateOrder, o.idContact " +
            "FROM orders o JOIN contact c ON o.idContact = c.id " +
            "ORDER BY name LIMIT ?,?",
            [min, pageSize], function (error, results, fields) {
            if (error) throw error;

            let list = [];

            results.forEach(function (account) {
                let json = {};
                json.id = account.id;
                json.name = account.name;
                json.clientName = account.clientName;
                json.amountTotal = account.amountTotal;
                json.dateOrder = account.dateOrder;
                json.idContact = account.idContact;
                list.push(json);
            });

            jsonResult.list = list;
            jsonResult.min = min;
            jsonResult.max = max;
            jsonResult.pageSize = pageSize;
            jsonResult.pageIndex = pageIndex;

            res.send(jsonResult);
            postStats(req, {author:accountId, obj:jsonResult}, 'ADMINISTRATEUR - Récupération de la liste de toutes les commandes',
                'SELECT');
        });
    }
    connection.end();
}

function searchOrders(req, res) {
    let connection = sql.createConnection(connConfig);
    let searchValue = req.body.value;
    let idContact = req.body.idContact;
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (pageIndex >= 0) {
        var jsonResult = {};
        let queryCount = "SELECT COUNT(id) AS length FROM orders o JOIN contact c ON o.idContact = c.id " +
            "WHERE (o.name LIKE ? OR dateOrder LIKE ? OR c.name LIKE ?)";
        let fieldsCount = [`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`];
        if (idContact) {
            queryCount += " AND o.idContact = ?";
            fieldsCount.push(idContact);
        }
        connection.query(queryCount, fieldsCount, function (error, results, fields) {
            if (results) {
                jsonResult.length = results[0].length;
            }
        });
        let query = "SELECT o.id, o.name, c.name AS clientName, o.amountTotal, o.dateOrder, o.idContact " +
            "FROM orders o JOIN contact c ON o.idContact = c.id " +
            "WHERE (o.name LIKE ? OR dateOrder LIKE ? OR c.name LIKE ?) ";
        let fields = [`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`];
        if (idContact) {
            query += " AND o.idContact = ?";
            fields.push(idContact);
        }
        query += " ORDER BY name LIMIT ?,?";
        fields.push(min);
        fields.push(pageSize);
        connection.query(query, fields, function (error, results, fields) {
            if (error) throw error;

            let list = [];

            results.forEach(function (account) {
                let json = {};
                json.id = account.id;
                json.name = account.name;
                json.clientName = account.clientName;
                json.amountTotal = account.amountTotal;
                json.dateOrder = account.dateOrder;
                json.idContact = account.idContact;
                list.push(json);
            });

            jsonResult.list = list;
            jsonResult.min = min;
            jsonResult.max = max;
            jsonResult.pageSize = pageSize;
            jsonResult.pageIndex = pageIndex;

            res.send(jsonResult);
        });
    }
    connection.end();
}

function getConsumerOrders(req, res) {
    let connection = sql.createConnection(connConfig);
    let idContact = req.params.id;
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(id) AS length" +
            " FROM orders" +
            " WHERE idContact = ?",
            [idContact], function (error, results, fields) {
                if (results) {
                    jsonResult.length = results[0].length;
                }
            });
    }
    connection.query("SELECT o.id, o.name, c.name AS clientName, o.amountTotal, o.dateOrder, o.idContact" +
        " FROM orders o" +
        " JOIN contact c ON o.idContact = c.id " +
        " WHERE idContact = ?" +
        " ORDER BY name LIMIT ?,?",
        [idContact, min, pageSize], function (error, results, fields) {
            if (error) throw error;

            let list = [];

            results.forEach(function (account) {
                let json = {};
                json.id = account.id;
                json.name = account.name;
                json.clientName = account.clientName;
                json.amountTotal = account.amountTotal;
                json.dateOrder = account.dateOrder;
                json.idContact = account.idContact;
                list.push(json);
            });

            jsonResult.list = list;
            jsonResult.min = min;
            jsonResult.max = max;
            jsonResult.pageSize = pageSize;
            jsonResult.pageIndex = pageIndex;

            res.send(jsonResult);
            postStats(req, {author:accountId, obj:jsonResult}, 'CLIENT - Récupération de la liste des commandes d\'un client',
                'SELECT');
        });
    connection.end();
}

function getOrder(req, res) {
    let connection = sql.createConnection(connConfig);
    let id = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("SELECT o.id, o.name, o.amountUntaxed, o.amountTax, o.amountTotal, o.state, o.dateCreate," +
        " o.dateOrder, o.idContact" +
        " FROM orders o" +
        " WHERE id = ? ",
        [id], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let line = results[0];
                let json = {};
                json.id = line.id;
                json.name = line.name;
                json.amountUntaxed = line.amountUntaxed;
                json.amountTax = line.amountTax;
                json.amountTotal = line.amountTotal;
                json.state = line.state;
                json.dateCreate = line.dateCreate;
                json.dateOrder = line.dateOrder;
                json.idContact = line.idContact;

                getOrderContact(req, json.idContact, accountId, function (contactName) {
                    json.clientName = contactName;
                    getOrderLines(req, json.id, accountId, function (lines) {
                        json.lines = lines;
                        res.send(json);
                        postStats(req, {author:accountId, obj:json}, 'CLIENT - Récupération d\'une commande',
                            'SELECT');
                    });
                });
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

function getOrderContact(req, idContact, accountId, success) {
    let connection = sql.createConnection(connConfig);
    connection.query("SELECT name" +
        " FROM contact" +
        " WHERE id = ? ",
        [idContact], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let line = results[0];
                success(line.name);
                postStats(req, {author:accountId, obj:line}, 'Récupération du contact d\'une commande',
                    'SELECT');
            }
        });
}

function getOrderLines(req, idOrder, accountId, success) {
    let connection = sql.createConnection(connConfig);
    connection.query("SELECT quantity, priceUnit, priceSubtotal, priceTax, priceTotal, dateCreate, dateWrite, idProduct" +
        " FROM orders_lines" +
        " WHERE idOrder = ? ",
        [idOrder], function (error, results, fields) {
            if (error) throw error;

            let lines = [];
            if (results) {
                results.forEach(line => {
                    let json = {};

                    json.quantity = line.quantity;
                    json.priceUnit = line.priceUnit;
                    json.priceSubtotal = line.priceSubtotal;
                    json.priceTax = line.priceTax;
                    json.priceTotal = line.priceTotal;
                    json.dateCreate = line.dateCreate;
                    json.dateWrite = line.dateWrite;
                    json.idProduct = line.idProduct;

                    getProduct(req, json.idProduct, accountId, function (productName) {
                        json.productName = productName;
                        lines.push(json);
                        if (lines.length === results.length) {
                            success(lines);
                            postStats(req, {author:accountId, obj:lines}, 'Récupération des lignes d\'une commande',
                                'SELECT');
                        }
                    });

                });
            }
        });
}

function getProduct(req, id, accountId, success) {
    let connection = sql.createConnection(connConfig);
    connection.query("SELECT name" +
        " FROM product" +
        " WHERE id = ? ",
        [id], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let line = results[0];
                success(line.name);
                postStats(req, {author:accountId, obj:id}, 'Récupération d\'un produit',
                    'SELECT');
            }
        });
}

function getClients(req, res) {
    let connection = sql.createConnection(connConfig);
    let min = req.body.min;
    let max = req.body.max;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(a.id) AS length" +
            " FROM account a" +
            " JOIN contact c ON c.id = a.idContact" +
            " JOIN account_groups_rel g ON a.id = g.idAccount" +
            " WHERE g.idGroup = 1 AND a.active = 1", function (error, results, fields) {
            if (results) {
                jsonResult.length = results[0].length;
            }
        });

        connection.query("SELECT a.id, c.name, c.displayName, c.phone, c.mobile, c.email, a.username, a.password, a.idContact" +
            " FROM account a" +
            " JOIN contact c ON c.id = a.idContact" +
            " JOIN account_groups_rel g ON a.id = g.idAccount" +
            " WHERE g.idGroup = 1 AND a.active = 1" +
            " ORDER BY name LIMIT ?,?",
            [min, pageSize], function (error, results, fields) {
                if (error) throw error;

                let list = [];

                results.forEach(function (account) {
                    let json = {};
                    json.id = account.id;
                    json.name = account.name;
                    json.displayName = account.displayName;
                    json.phone = account.phone;
                    json.username = account.username;
                    json.email = account.email;
                    json.idContact = account.idContact;
                    list.push(json);
                });

                jsonResult.list = list;
                jsonResult.min = min;
                jsonResult.max = max;
                jsonResult.pageSize = pageSize;
                jsonResult.pageIndex = pageIndex;

                res.send(jsonResult);
                postStats(req, {author:accountId, obj:jsonResult}, 'COMMERCIAL - Récupération de la liste de clients',
                    'SELECT');
            });
    }
    connection.end();
}

function searchClients(req, res) {
    let connection = sql.createConnection(connConfig);
    let min = req.body.min;
    let max = req.body.max;
    let searchValue = req.body.value;
    let pageSize = req.body.pageSize;
    let pageIndex = req.body.pageIndex;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    if (pageIndex >= 0) {
        var jsonResult = {};
        connection.query("SELECT COUNT(a.id) AS length" +
            " FROM account a" +
            " JOIN contact c ON c.id = a.idContact" +
            " JOIN account_groups_rel g ON a.id = g.idAccount" +
            " WHERE (c.name LIKE ? OR c.displayName LIKE ? OR c.email LIKE ? OR c.mobile LIKE ? OR c.phone LIKE ?) AND g.idGroup = 1 AND a.active = 1",
            [`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`],
            function (error, results, fields) {
                if (results) {
                    jsonResult.length = results[0].length;
                }
            });

        connection.query("SELECT a.id, c.name, c.displayName, c.phone, c.mobile, c.email, a.username, a.password, a.idContact" +
            " FROM account a" +
            " JOIN contact c ON c.id = a.idContact" +
            " JOIN account_groups_rel g ON a.id = g.idAccount" +
            " WHERE (c.name LIKE ? OR c.displayName LIKE ? OR c.email LIKE ? OR c.mobile LIKE ? OR c.phone LIKE ?) AND g.idGroup = 1 AND a.active = 1" +
            " ORDER BY name LIMIT ?,?",
            [`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`,`%${searchValue}%`, min, pageSize], function (error, results, fields) {
                if (error) throw error;

                let list = [];

                results.forEach(function (account) {
                    let json = {};
                    json.id = account.id;
                    json.name = account.name;
                    json.displayName = account.displayName;
                    json.phone = account.phone;
                    json.username = account.username;
                    json.email = account.email;
                    json.idContact = account.idContact;
                    list.push(json);
                });

                jsonResult.list = list;
                jsonResult.min = min;
                jsonResult.max = max;
                jsonResult.pageSize = pageSize;
                jsonResult.pageIndex = pageIndex;

                res.send(jsonResult);
            });
    }
    connection.end();
}

function getClient(req, res) {
    let connection = sql.createConnection(connConfig);
    let clientId = req.params.id;
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    connection.query("SELECT a.id, a.username, c.email, c.name, c.displayName, c.phone, c.mobile, a.idContact" +
        " FROM account a" +
        " JOIN contact c ON a.idContact = c.id " +
        " WHERE a.id = ? AND a.active = 1",
        [clientId], function (error, results, fields) {
            if (error) throw error;

            if (results && results[0]) {
                let account = results[0];
                let json = {};
                json.id = account.id;
                json.name = account.name;
                json.displayName = account.displayName;
                json.phone = account.phone;
                json.mobile = account.mobile;
                json.username = account.username;
                json.email = account.email;
                json.idContact = account.idContact;

                res.send(json);
                postStats(req, {author:accountId, obj:json}, 'COMMERCIAL - Récupération d\'un client',
                    'SELECT');
            } else {
                res.status(500).send();
            }
        });
    connection.end();
}

app.route('/api/files/update/:idDoc').post(checkIfAuthenticated, type, function (req, res) {
    // Récupération des données token décryptées
    let idDoc = req.params.idDoc;
    let state = req.params.state;
    let file = req.file;
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let fileFolder = "./files/" + Date.now();
    fs.mkdir(fileFolder, {recursive: true}, function (err) {
        if (err) {
            console.log(err);
        } else {
            let filename = file.originalname;
            let correctedFilename = filename.split(' ').join('_');
            filename = correctedFilename;
            let filePath = fileFolder + '/' + filename;
            fs.writeFile(filePath, file.buffer, function (err) {
                if (err) {
                    console.log(err);
                }

                // Ecrire en BDD
                let connection = sql.createConnection(connConfig);
                connection.query('UPDATE docs SET name = ?, path = ? WHERE id = ?',
                    [file.originalname, filePath, idDoc],
                    function (error, results, fields) {
                        if (error) throw error;
                        res.send({type: 1, loaded: 100, total: 100});
                        postStats(req, {author:accountId, obj:file}, 'CHERCHEUR - Mise à jour d\'un fichier de suivi de création de produit',
                            'UPDATE');
                    });
                connection.end();
            });
        }
    });
});

app.route('/api/files/upload/:idDocsProduct/:state').post(checkIfAuthenticated, type, function (req, res) {
    // Récupération des données token décryptées
    let idDocsProduct = req.params.idDocsProduct;
    let state = req.params.state;
    let file = req.file;
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let fileFolder = "./files/" + Date.now();
    fs.mkdir(fileFolder, {recursive: true}, function (err) {
        if (err) {
            console.log(err);
        } else {
            let filename = file.originalname;
            let correctedFilename = filename.split(' ').join('_');
            filename = correctedFilename;
            let filePath = fileFolder + '/' + filename;
            fs.writeFile(filePath, file.buffer, function (err) {
                if (err) {
                    console.log(err);
                }

                // Ecrire en BDD
                let connection = sql.createConnection(connConfig);
                connection.query('INSERT INTO docs (name, path, state, idDocsProduct, idAccount) VALUES (?,?,?,?,' +
                    '(SELECT id FROM account WHERE username = ? AND active IS TRUE))',
                    [file.originalname, filePath, state, idDocsProduct, accountId],
                    function (error, results, fields) {
                        if (error) throw error;
                        res.send({type: 1, loaded: 100, total: 100});
                        file.idDocsProduct = idDocsProduct;
                        file.state = state;
                        postStats(req, {author:accountId, obj:file}, 'CHERCHEUR - Ajout de document à un suivi de création de produit',
                            'INSERT');
                    });
                connection.end();
            });
        }
    });
});

app.route('/api/account/infos').get(checkIfAuthenticated, function (req, res) {
    // Récupération des données token décryptées
    let decodedReq = req.user;
    let accountId = decodedReq.id;

    let connection = sql.createConnection(connConfig);
    connection.query("SELECT a.id, a.username, c.displayName AS name, c.email, a.idContact" +
        " FROM account a" +
        " JOIN contact c ON a.idContact = c.id" +
        " WHERE a.username=? AND a.active = 1",
        [accountId],
        function (error, results, fields) {
            if (error) throw error;

            let jsonResult = {};
            if (results.length > 0) {
                let account = results[0];
                jsonResult.id = account.id;
                jsonResult.name = account.name;
                jsonResult.email = account.email;
                jsonResult.username = account.username;
                jsonResult.idContact = account.idContact;
            }
            res.send(jsonResult);
            postStats(req, {author:accountId, obj:jsonResult}, 'UTILISATEUR - Récupération d\'informations utilisateur',
                'SELECT');
        });
    connection.end();
});

function updatePassword(req, accountId, password, authorId, success, failure) {
    let connection = sql.createConnection(connConfig);
    generateCryptedPassword(password, function (cryptedPassword) {
        connection.query("UPDATE account SET password= ? WHERE username=? AND active = 1",
            [cryptedPassword, accountId],
            function (error, results, fields) {
                if (error) throw error;
                if (results) {
                    odooConnection.query('UPDATE res_users SET password = $1 WHERE login = $2',
                        [cryptedPassword, accountId], (error, results) => {
                            if (error) {  throw error; }
                            if (results) {
                                success();
                                postStats(req, {author:authorId, obj:accountId}, 'BV+ODOO - Mise à jour de mot de passe',
                                    'UPDATE');
                            } else { failure(); }
                        });
                } else { failure(); }
            });
        connection.end();
    });
}

const FIELD_EMAIL = "email";
const FIELD_PASSWORD = "password";
const FIELD_NAME = "name";
app.route('/api/account/update/:field').patch(checkIfAuthenticated, function (req, res) {
    // Récupération des données token décryptées
    let decodedReq = req.user;
    let accountId = decodedReq.id;
    let field = req.params.field;
    let oldValue = req.body.oldValue;
    let newValue = req.body.newValue;

    let connection = sql.createConnection(connConfig);
    let strQuery = null;
    let fieldsQuery = null;
    switch (field) {
        case FIELD_EMAIL:
            strQuery = "SELECT email AS actualValue FROM contact c JOIN account a ON c.id = a.idContact WHERE username=?";
            fieldsQuery = [accountId];
            break;
        case FIELD_NAME:
            strQuery = "SELECT displayName AS actualValue FROM contact c JOIN account a ON c.id = a.idContact WHERE username=?";
            fieldsQuery = [accountId];
            break;
        case FIELD_PASSWORD:
            strQuery = "SELECT password AS actualValue FROM account WHERE username=?";
            fieldsQuery = [accountId];
            break;
    }

    if (strQuery && fieldsQuery) {
        connection.query(strQuery, fieldsQuery,
            function (error, results, fields) {
                if (error) throw error;

                if (results) {
                    let actualValue = results[0].actualValue;
                    if (field === FIELD_PASSWORD) {
                        verifyPassword(oldValue, actualValue, function (isValid) {
                            if (isValid) {
                                updatePassword(req, accountId, newValue, accountId, function () {
                                    res.status(200).send();
                                    postStats(req, {author:accountId, obj:{field, oldValue, newValue}},
                                        'UTILISATEUR - Mise à jour d\'informations utilisateur',
                                        'UPDATE');
                                }, function (error) {
                                    res.status(501).send();
                                })
                            }
                        });
                    } else if (oldValue === actualValue) {
                        updateAccountField(req, res, accountId, field, oldValue, newValue);
                    }
                }
            });
        connection.end();
    } else {
        res.status(404).send();
    }
});

function updateAccountField(req, res, accountId, field, oldValue, newValue) {
    let strQuery = null;
    let fieldsQuery = null;
    let strOdooQuery = null;
    let fieldsOdooQuery = null;
    switch (field) {
        case FIELD_NAME:
            strQuery = "UPDATE contact SET name=? WHERE name=? AND id = (SELECT idContact FROM account WHERE username=?)";
            fieldsQuery = [newValue, oldValue, accountId];
            strOdooQuery = "UPDATE res_partner SET display_name=$1 WHERE id = (SELECT partner_id FROM res_users WHERE login=$2)";
            fieldsOdooQuery = [newValue, accountId];
            break;
        case FIELD_EMAIL:
            strQuery = "UPDATE contact SET email=? WHERE email=? AND id = (SELECT idContact FROM account WHERE username=?)";
            fieldsQuery = [newValue, oldValue, accountId];
            strOdooQuery = "UPDATE res_partner SET email=$1 WHERE id = (SELECT partner_id FROM res_users WHERE login=$2)";
            fieldsOdooQuery = [newValue, accountId];
            break;
    }
    if (strQuery) {
        let connection = sql.createConnection(connConfig);
        connection.query(strQuery,
            fieldsQuery,
            function (error, results, fields) {
                if (error) throw error;
                if (results) {
                    odooConnection.query(strOdooQuery,
                        fieldsOdooQuery, (error, results) => {
                            if (error) { throw error; }
                            if (results) {
                                res.status(200).send();
                                postStats(req, {author:accountId, obj:{field, oldValue, newValue}},
                                    'UTILISATEUR - Mise à jour d\'informations utilisateur',
                                    'UPDATE');
                            }
                        });
                }
            });
        connection.end();
    } else {
        res.status(404).send();
    }
}


app.post('/api/login', function (req, res) {
    const id = req.body.id,
        password = req.body.password;

    validateLogin(id, password,
        function (accountGroups) {
            const jwtBearerToken = generateBearerToken(id, accountGroups);
            res.cookie("SESSIONID", jwtBearerToken, {httpOnly: true, secure: true});
            res.status(200).json({
                idToken: jwtBearerToken,
            }).send();
            postStats(req, {author:id, obj:id},
                'UTILISATEUR - Connexion utilisateur',
                'LOGIN');
        }, function () {
            // Unauthorized
            res.sendStatus(401);
        });
});


function generateBearerToken(userId, userGroups) {
    // Connecté 24h
    return jwt.sign({
        id: userId,
        groups: userGroups
    }, RSA_PRIVATE_KEY, {
        algorithm: 'RS256',
        issuer: 'urn:issuer',
        expiresIn: 60 * 60 * 24,
        subject: 'BuenaVistaLogin'
    });
}

function validateLogin(id, password, success, failure) {
    let connection = sql.createConnection(connConfig);

    connection.query("SELECT password FROM account WHERE active = 1 AND username = ? AND password IS NOT NULL",
        [id],
        function (error, results, fields) {
            if (error) throw error;

            if (results.length > 0) {
                let hash = results[0].password;
                verifyPassword(password, hash, function (isValid) {
                    if (isValid) {
                        connection.query("SELECT idGroup FROM account_groups_rel WHERE idAccount = " +
                            "(SELECT id FROM account WHERE active = 1 AND username = ?)",
                            [id],
                            function (error, results, fields) {
                                if (error) throw error;

                                let groups = [];

                                results.forEach(function (group) {
                                    groups.push(group.idGroup);
                                });

                                if (results.length > 0) {
                                    success(groups);
                                } else {
                                    failure();
                                }
                            });
                    } else {
                        failure();
                    }
                });
            } else {
                failure();
            }
        });
}

function generateCryptedPassword(password, callback) {
    const pythonProcess = spawn('python', ["./genPwd.py", password]);
    let pwd;
    pythonProcess.stdout.on('data', (data) => {
        callback(data.toString().trim());
    });
}

function verifyPassword(password, hash, callback) {
    const pythonProcess = spawn('python', ["./verifPwd.py", password, hash]);
    let pwd;
    pythonProcess.stdout.on('data', (data) => {
        callback(data.toString().trim() === 'True');
    });
}

function postStats(req, data, desc, method) {
    let stat = {};
    stat.data = data;
    stat.specs = {};
    stat.specs.date = new Date();
    stat.specs.url = req.originalUrl;
    stat.specs.desc = desc;
    stat.specs.method = method;

    request({ url: 'https://185.116.106.69:5555/api/stats', method: "POST", json: stat });
}
